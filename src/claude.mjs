// Runs the Claude Code CLI (`claude -p`) for one request.
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { isFile, readAgentEnv, readInstructions } from './agents.mjs'
import { ALLOWED_TOOLS, CLAUDE_BIN, DATA_DIR, TIMEOUT_MS, UNTRUSTED_TOOLS, WORKSPACE } from './config.mjs'
import { HttpError } from './http.mjs'

// Tells Claude what the image ships, so it doesn't waste turns probing or give up on binary formats
const SYSTEM_HINT =
  'Document tools installed in this environment: pandoc (PDF output via --pdf-engine=weasyprint), ' +
  'LibreOffice headless (`soffice --headless --convert-to pdf|docx|xlsx|pptx <file>`), ' +
  'poppler-utils (pdftotext, pdftoppm), qpdf, ghostscript, ocrmypdf, tesseract (eng, ita), imagemagick, zip/unzip, ' +
  'and python3 with python-docx, openpyxl, python-pptx, pypdf, pdfplumber, pymupdf and reportlab. ' +
  'When asked to change a document, deliver it in the same format it was provided in. ' +
  'For .docx/.xlsx/.pptx, edit the file with the Python libraries so formatting is preserved; do not rebuild it from plain text. ' +
  'A PDF has no editable source: produce a new PDF with the revised content and say that the layout was regenerated.'

// What the Claude process may see of the server's environment when it runs an agent from an untrusted source:
// enough for Claude Code to start and log in, and none of the secrets meant for trusted agents' tools.
const SAFE_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TZ|TMPDIR|TERM|CLAUDE_\w+|ANTHROPIC_\w+|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY)$/i

const memoryNote = (agent) =>
  `${agent.dataDir} is your private data folder: it persists between requests and is never published. ` +
  `If ${agent.dataDir}/MEMORY.md exists, read it before you answer. When you learn something that should hold for ` +
  `future requests (a correction, a preference, a decision), record it in that file.`

const instructionsNote = async (agent) =>
  `\n\nYour instructions as this agent:\n<agent-instructions>\n${await readInstructions(agent)}\n</agent-instructions>`

// How one agent runs: {cwd, env, args, note}. There are three cases.
async function agentRun(agent, uploadDir) {
  await mkdir(agent.dataDir, { recursive: true })
  const workspaceNote = `Files for the caller live in ${WORKSPACE}: read attachments there and put new output files there, not in the current directory.`
  const trustedArgs = ['--allowedTools', agent.allowedTools ?? ALLOWED_TOOLS, '--add-dir', WORKSPACE, agent.dataDir]
  if (agent.trusted && agent.model) trustedArgs.push('--model', agent.model)
  // --allowedTools only pre-approves; --tools removes every other built-in tool from the session
  if (agent.trusted && agent.tools) trustedArgs.push('--tools', agent.tools)
  // where the agent's scripts find its folders, plus the secrets from its own .env
  const trustedEnv = { ...process.env, ...(await readAgentEnv(agent)), AGENT_DATA_DIR: agent.dataDir, AGENT_WORKSPACE: WORKSPACE }

  // 1. A folder agent from a trusted place runs inside its folder, so Claude Code loads its CLAUDE.md, skills,
  //    settings and tools itself.
  if (agent.trusted && agent.format === 'folder') {
    const mcpConfig = path.join(agent.dir, '.mcp.json')
    if (await isFile(mcpConfig)) trustedArgs.push('--mcp-config', mcpConfig, '--strict-mcp-config')
    return {
      cwd: agent.dir,
      env: trustedEnv,
      args: trustedArgs,
      note: ` You are running as the agent "${agent.name}"; your instructions are the CLAUDE.md in the current directory. ${workspaceNote} ${memoryNote(agent)}`,
    }
  }

  // The other two run in an empty folder of their own, with the instructions passed as text. Project settings are
  // not loaded there, so nothing written into that folder can add hooks or permissions, and no MCP servers start.
  const key = path.basename(agent.dataDir)
  const cwd = path.join(DATA_DIR, 'run', key)
  await mkdir(cwd, { recursive: true })
  const isolated = ['--setting-sources', 'user', '--strict-mcp-config']

  // 2. A single-file agent from a trusted place: same tools and reach as case 1.
  if (agent.trusted) {
    return {
      cwd,
      env: trustedEnv,
      args: [...trustedArgs, ...isolated],
      note: ` You are running as the agent "${agent.name}". ${workspaceNote} ${memoryNote(agent)}${await instructionsNote(agent)}`,
    }
  }

  // 3. Any agent from an untrusted source. It contributes instructions and nothing else:
  //    - only UNTRUSTED_TOOLS exist in the session (--tools), so there is no shell and no network;
  //    - no tool is pre-approved; "acceptEdits" lets it read and write inside its own folders and refuses the rest,
  //      so it cannot reach the rest of the workspace, other agents' data, or Claude's own settings;
  //    - the process gets neither the secrets in the server's environment nor a .env of its own.
  const outDir = path.join(WORKSPACE, 'agent-files', key)
  await mkdir(outDir, { recursive: true })
  const dirs = [agent.dataDir, outDir, ...(uploadDir ? [uploadDir] : [])]
  return {
    cwd,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => SAFE_ENV.test(name))),
    args: ['--tools', UNTRUSTED_TOOLS, '--permission-mode', 'acceptEdits', '--add-dir', ...dirs, ...isolated],
    note:
      ` You are running as the agent "${agent.name}". You can only read and write inside these folders: ${dirs.join(', ')}. ` +
      `Put files meant for the caller in ${outDir}. ${memoryNote(agent)}${await instructionsNote(agent)}`,
  }
}

// Claude processes that are running now, so they can be stopped when the server stops.
const children = new Set()
export function stopRunningClaude() {
  for (const child of children) child.kill('SIGKILL')
}

// `session` is {resume: id} to continue a session or {start: id} to create one with a chosen id.
// `uploadDir` is the folder holding this request's attachments, if any.
// `signal` (an AbortSignal) stops the run early; the rejection then has `cancelled: true`.
export async function runClaude(prompt, { session = {}, agent, schema, uploadDir, timeoutMs = TIMEOUT_MS, signal } = {}) {
  const run = agent
    ? await agentRun(agent, uploadDir)
    : { cwd: WORKSPACE, env: process.env, args: ['--allowedTools', ALLOWED_TOOLS], note: '' }
  const args = ['-p', prompt, '--output-format', 'json', ...run.args, '--append-system-prompt', SYSTEM_HINT + run.note]
  if (schema) args.push('--json-schema', schema)
  if (session.resume) args.push('--resume', session.resume)
  else if (session.start) args.push('--session-id', session.start)
  return new Promise((resolve, reject) => {
    // stdin must be closed, otherwise `claude -p` waits for piped input
    const child = spawn(CLAUDE_BIN, args, { cwd: run.cwd, env: run.env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    const abort = () => child.kill('SIGKILL')
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const done = () => {
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
