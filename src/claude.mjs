// Runs the Claude Code CLI (`claude -p`) for one request.
//
// Every run is confined to its own folders: the request's context folder (see context.mjs) and, for an agent, the
// agent's folder and its private data folder. Two layers keep it there:
//   - file tools (Read, Edit, Glob, ...) only work in the working directories: `cwd` and the `--add-dir` folders;
//   - Bash runs in Claude Code's sandbox (bubblewrap), which cannot read the rest of the workspace, other agents' data
//     or Claude's own config and transcripts, and can only write to the run's folders.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { readAgentEnv, readInstructions } from './agents.mjs'
import {
  ALLOWED_TOOLS, CLAUDE_BIN, CLAUDE_CONFIG_DIR, DATA_DIR, SANDBOX_ALLOWED_DOMAINS, SANDBOX_LIBREOFFICE, SANDBOX_NESTED,
  TIMEOUT_MS, UNTRUSTED_TOOLS, WORKSPACE,
} from './config.mjs'
import { contextPrefix } from './context.mjs'
import { HttpError } from './http.mjs'
import { listSources } from './sources.mjs'

// Tells Claude what the image ships, so it doesn't waste turns probing or give up on binary formats
const SYSTEM_HINT =
  'Document tools installed in this environment: pandoc (PDF output via --pdf-engine=weasyprint), ' +
  'LibreOffice headless (`soffice --headless --convert-to pdf|docx|xlsx|pptx <file>`), ' +
  'poppler-utils (pdftotext, pdftoppm), qpdf, ghostscript, ocrmypdf, tesseract (eng, ita), imagemagick, zip/unzip, ' +
  'and python3 with python-docx, openpyxl, python-pptx, pypdf, pdfplumber, pymupdf, reportlab and pyyaml. ' +
  'When asked to change a document, deliver it in the same format it was provided in. ' +
  'For .docx/.xlsx/.pptx, edit the file with the Python libraries so formatting is preserved; do not rebuild it from plain text. ' +
  'A PDF has no editable source: produce a new PDF with the revised content and say that the layout was regenerated.'

// What the Claude process may see of the server's environment when it runs without an agent or an agent from an
// untrusted source: enough for Claude Code to start and log in, and none of the secrets meant for trusted agents' tools.
const SAFE_ENV = /^(PATH|USER|LOGNAME|SHELL|LANG|LC_\w+|TZ|TERM|CLAUDE_\w+|ANTHROPIC_\w+|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY)$/i
const safeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => SAFE_ENV.test(name)))

// Trusted agents keep the server's environment (their .mcp.json refers to its secrets as ${NAME}), except the
// server's own credentials: the API token and the tokens that fetch agent sources.
async function trustedEnv() {
  const env = { ...process.env }
  delete env.API_TOKEN
  for (const source of await listSources()) if (source.tokenEnv) delete env[source.tokenEnv]
  return env
}

// File tools named without a path would be pre-approved everywhere. Without them in --allowedTools, they still work
// in the working directories (acceptEdits approves edits there, reads need no approval) and are refused elsewhere.
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'NotebookRead'])
const scopeAllowedTools = (list) =>
  list.split(',').map((t) => t.trim()).filter((t) => t && !FILE_TOOLS.has(t)).join(',')

// Each run's temporary files (Claude's own, the sandbox's proxy sockets, tools' TMPDIR) go to a folder of its own
// under TMP_ROOT, which the other runs cannot see. The path is kept short: Unix socket paths are limited to 108 bytes.
const TMP_ROOT = '/tmp/claude-runs'

// The per-run settings.
//   readable   folders the sandbox lets Bash read inside the otherwise hidden areas
//   readOnly   files and folders that Bash and the file tools may read but not change
//   domains    the only hosts Bash can reach (none when empty)
function runSettings({ readable, readOnly = [], domains = [], tmp }) {
  return JSON.stringify({
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      deny: readOnly.flatMap((p) => [`Edit(/${p})`, `Edit(/${p}/**)`]),
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      enableWeakerNestedSandbox: SANDBOX_NESTED,
      filesystem: {
        denyRead: [WORKSPACE, DATA_DIR, CLAUDE_CONFIG_DIR, TMP_ROOT],
        allowRead: [...readable, tmp],
        // LibreOffice puts its pipe in /tmp, whatever TMPDIR says
        allowWrite: [tmp, ...(SANDBOX_LIBREOFFICE ? ['/tmp'] : [])],
        denyWrite: readOnly,
      },
      // LibreOffice talks to its own process over a Unix socket
      network: { allowedDomains: domains, ...(SANDBOX_LIBREOFFICE && { allowAllUnixSockets: true }) },
    },
  })
}

// Where a run keeps the files that tools write in the home folder. HOME itself is read-only for the run: a shell
// start-up file or a git config written there would be read on the next turn by processes outside the sandbox.
// Caches and tool data (pip, pnpm, corepack, uv) go to writable folders next to it instead.
async function homeFor(base) {
  const home = path.join(base, '.home')
  const xdg = {
    XDG_CACHE_HOME: path.join(base, '.cache'),
    XDG_DATA_HOME: path.join(base, '.local', 'share'),
    XDG_STATE_HOME: path.join(base, '.local', 'state'),
  }
  for (const dir of [home, ...Object.values(xdg)]) await mkdir(dir, { recursive: true })
  return { home, env: { HOME: home, ...xdg } }
}

// The run's private temporary folder; runClaude removes it when the run ends.
async function tmpFor() {
  const tmp = path.join(TMP_ROOT, randomBytes(6).toString('hex'))
  await mkdir(tmp, { recursive: true, mode: 0o700 })
  return { tmp, env: { TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp } }
}

// The agent's .mcp.json, or null. A killed run can leave an empty one behind (the sandbox's placeholder for a file it
// protects), which Claude Code would refuse, failing every later turn.
async function mcpConfigOf(agent) {
  const file = path.join(agent.dir, '.mcp.json')
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text == null) return null
  try {
    JSON.parse(text)
    return file
  } catch {
    console.error(`agent "${agent.name}": ignoring ${file}, which is ${text.trim() ? 'not valid JSON' : 'empty'}`)
    return null
  }
}

const memoryNote = (agent) =>
  `${agent.dataDir} is your private data folder: it persists between requests and is never published. ` +
  `If ${agent.dataDir}/MEMORY.md exists, read it before you answer. When you learn something that should hold for ` +
  `future requests (a correction, a preference, a decision), record it in that file.`

const instructionsNote = async (agent) =>
  `\n\nYour instructions as this agent:\n<agent-instructions>\n${await readInstructions(agent)}\n</agent-instructions>`

const filesNote = (dir) =>
  `Files for the caller live in ${dir}: read attachments there and put new output files there. ` +
  `Nothing outside ${dir} and the folders named here is available to you.`

// Settings and MCP servers are taken only from the user settings and the flags below, so nothing written into a
// run's folders can add hooks, permissions or MCP servers.
const ISOLATED = ['--setting-sources', 'user', '--strict-mcp-config']

// A run without an agent: its context folder is its working directory and the only folder it has.
async function plainRun(contextDir) {
  const home = await homeFor(contextDir)
  const tmp = await tmpFor()
  return {
    cwd: contextDir,
    tmp: tmp.tmp,
    env: { ...safeEnv(), ...home.env, ...tmp.env },
    args: [
      '--allowedTools', scopeAllowedTools(ALLOWED_TOOLS), '--permission-mode', 'acceptEdits', ...ISOLATED,
      '--settings', runSettings({
        readable: [contextDir], readOnly: [home.home], domains: SANDBOX_ALLOWED_DOMAINS, tmp: tmp.tmp,
      }),
    ],
    note: ` ${filesNote(contextDir)}`,
  }
}

// How one agent runs: {cwd, env, args, note}. There are three cases.
async function agentRun(agent, contextDir) {
  await mkdir(agent.dataDir, { recursive: true })
  // tools' caches go to the agent's own folder, which persists between requests
  const home = await homeFor(agent.dataDir)
  const tmp = await tmpFor()
  // the agent's secrets and home are read by the next turn's Claude process, outside the sandbox: only the API
  // (PUT /agents/<agent>/data/.env) may change them
  const protectedFiles = [path.join(agent.dataDir, '.env'), home.home]
  const dirs = [contextDir, agent.dataDir]
  const readable = [...dirs, ...(agent.dir ? [agent.dir] : [])]
  const domains = [...SANDBOX_ALLOWED_DOMAINS, ...(agent.allowedDomains ?? [])]
  const trustedArgs = [
    '--allowedTools', scopeAllowedTools(agent.allowedTools ?? ALLOWED_TOOLS), '--permission-mode', 'acceptEdits',
    '--add-dir', ...dirs,
  ]
  if (agent.trusted && agent.model) trustedArgs.push('--model', agent.model)
  // --allowedTools only pre-approves; --tools removes every other built-in tool from the session
  if (agent.trusted && agent.tools) trustedArgs.push('--tools', agent.tools)
  // where the agent's scripts find its folders, plus the secrets from its own .env
  const folders = {
    ...home.env,
    ...tmp.env,
    AGENT_DATA_DIR: agent.dataDir,
    AGENT_WORKSPACE: contextDir,
    // the context folder as /files/<path> names it, for scripts that print download paths
    AGENT_FILES_PREFIX: contextPrefix(contextDir),
  }
  const env = { ...(await trustedEnv()), ...(await readAgentEnv(agent)), ...folders }

  // 1. A folder agent from a trusted place runs inside its folder, so Claude Code loads its CLAUDE.md, skills,
  //    settings and tools itself.
  if (agent.trusted && agent.format === 'folder') {
    const mcpConfig = await mcpConfigOf(agent)
    if (mcpConfig) trustedArgs.push('--mcp-config', mcpConfig, '--strict-mcp-config')
    return {
      cwd: agent.dir,
      tmp: tmp.tmp,
      env,
      args: [...trustedArgs, '--settings', runSettings({ readable, readOnly: protectedFiles, domains, tmp: tmp.tmp })],
      note: ` You are running as the agent "${agent.name}"; your instructions are the CLAUDE.md in the current directory. ${filesNote(contextDir)} ${memoryNote(agent)}`,
    }
  }

  // The other two run in an empty folder of their own, with the instructions passed as text. Project settings are
  // not loaded there, so nothing written into that folder can add hooks or permissions, and no MCP servers start.
  const key = path.basename(agent.dataDir)
  const cwd = path.join(DATA_DIR, 'run', key)
  await mkdir(cwd, { recursive: true })
  readable.push(cwd)

  // 2. A single-file agent from a trusted place: same tools and reach as case 1.
  if (agent.trusted) {
    return {
      cwd,
      tmp: tmp.tmp,
      env,
      args: [
        ...trustedArgs, ...ISOLATED,
        '--settings', runSettings({ readable, readOnly: protectedFiles, domains, tmp: tmp.tmp }),
      ],
      note: ` You are running as the agent "${agent.name}". ${filesNote(contextDir)} ${memoryNote(agent)}${await instructionsNote(agent)}`,
    }
  }

  // 3. Any agent from an untrusted source. It contributes instructions and nothing else:
  //    - only UNTRUSTED_TOOLS exist in the session (--tools), so there is no shell and no network;
  //    - no tool is pre-approved; "acceptEdits" lets it read and write inside its own folders and refuses the rest;
  //    - its own folder (reference files, schemas) is readable but not writable;
  //    - the process gets neither the secrets in the server's environment nor a .env of its own.
  const ownFiles = agent.dir ? [agent.dir] : []
  const untrustedDirs = [...dirs, ...ownFiles]
  return {
    cwd,
    tmp: tmp.tmp,
    env: { ...safeEnv(), ...folders },
    args: [
      '--tools', UNTRUSTED_TOOLS, '--permission-mode', 'acceptEdits', '--add-dir', ...untrustedDirs, ...ISOLATED,
      '--settings', runSettings({ readable, readOnly: [...ownFiles, ...protectedFiles], tmp: tmp.tmp }),
    ],
    note:
      ` You are running as the agent "${agent.name}". You can only read and write inside these folders: ${dirs.join(', ')}` +
      `${ownFiles.length ? `, and read your own files in ${ownFiles[0]}` : ''}. ` +
      `Put files meant for the caller in ${contextDir}. ${memoryNote(agent)}${await instructionsNote(agent)}`,
  }
}

// Temporary folders of runs that a previous server process did not live to remove.
export const clearRunTmp = () => rm(TMP_ROOT, { recursive: true, force: true })

// Claude processes that are running now, so they can be stopped when the server stops.
const children = new Set()
export function stopRunningClaude() {
  for (const child of children) child.kill('SIGKILL')
}

// `session` is {resume: id} to continue a session or {start: id} to create one with a chosen id.
// `contextDir` is the request's folder in the workspace (see context.mjs).
// `signal` (an AbortSignal) stops the run early; the rejection then has `cancelled: true`.
export async function runClaude(prompt, { session = {}, agent, schema, contextDir, timeoutMs = TIMEOUT_MS, signal } = {}) {
  const run = agent ? await agentRun(agent, contextDir) : await plainRun(contextDir)
  // the prompt goes in on stdin: command lines can be read by every process in the container, sandboxed ones included
  const args = ['-p', '--output-format', 'json', ...run.args, '--append-system-prompt', SYSTEM_HINT + run.note]
  if (schema) args.push('--json-schema', schema)
  if (session.resume) args.push('--resume', session.resume)
  else if (session.start) args.push('--session-id', session.start)
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: run.cwd, env: run.env, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    // stdin must be closed, otherwise `claude -p` waits for more input
    child.stdin.on('error', () => {}) // the process may exit before reading it; 'close' reports why
    child.stdin.end(prompt)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const abort = () => child.kill('SIGKILL')
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const done = () => {
      rm(run.tmp, { recursive: true, force: true }).catch(() => {})
      children.delete(child)
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    child.on('error', (err) => {
      done()
      reject(new HttpError(500, `could not start claude: ${err.message}`))
    })
    child.on('close', (code, killedBy) => {
      done()
      if (signal?.aborted) return reject(Object.assign(new HttpError(499, 'cancelled'), { cancelled: true }))
      if (killedBy) return reject(new HttpError(504, `claude timed out after ${timeoutMs / 1000}s`))
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new HttpError(502, `claude exited with code ${code}: ${(stderr || stdout).trim().slice(0, 2000)}`))
      }
    })
  })
}
