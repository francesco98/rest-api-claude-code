// Finding agents on disk and reading what a request needs from them.
//
// An agent is either a folder with a CLAUDE.md, or a single Markdown file whose front matter has `name` and
// `description` (Claude Code's subagent format). Local agents (AGENTS_DIR and ./agents) are called by name;
// agents from a source (see sources.mjs) are called as `source/name`.
import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { AGENT_ROOTS, DATA_DIR } from './config.mjs'
import { HttpError } from './http.mjs'
import { listSources, sourceRoot } from './sources.mjs'

export const NAME = /^[a-z0-9][a-z0-9_-]*$/
// A name as callers send it: `triage` or `source/triage`
export const AGENT_NAME = /^([a-z0-9][a-z0-9_-]*\/)?[a-z0-9][a-z0-9_-]*$/
const DATA_ROOT = path.join(DATA_DIR, 'data')

export const isFile = (file) => stat(file).then((s) => s.isFile(), () => false)

// `key: value` lines and `- item` lists from the block between the leading `---` lines; enough for subagent headers.
function parseFrontMatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return null
  const header = {}
  let listKey = null
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && listKey) {
      header[listKey].push(item[1].trim())
      continue
    }
    const pair = line.match(/^([\w-]+):\s*(.*)$/)
    if (!pair) continue
    const value = pair[2].trim().replace(/^(["'])(.*)\1$/, '$2')
    listKey = value === '' ? pair[1] : null
    header[pair[1]] = value === '' ? [] : value
  }
  return { header, body: text.slice(match[0].length) }
}

const toolList = (tools) => (Array.isArray(tools) ? tools.join(',') : tools) || undefined

function agentRecord(source, name, fields) {
  return {
    name: source ? `${source.name}/${name}` : name,
    source: source?.name ?? 'local',
    trusted: source ? source.trusted : true,
    dataDir: path.join(DATA_ROOT, source ? `${source.name}+${name}` : name),
    ...fields,
  }
}

// Folder agent. Optional agent.json next to CLAUDE.md: {description, tools, allowedTools, model}.
// `tools` limits which built-in tools exist in the session; `allowedTools` says which run without asking.
async function readFolderAgent(dir, source) {
  const name = path.basename(dir)
  const settings = await readFile(path.join(dir, 'agent.json'), 'utf8').then(JSON.parse, (err) => {
    if (err.code === 'ENOENT') return {}
    throw new HttpError(500, `agent "${name}" has an unreadable agent.json: ${err.message}`)
  })
  return agentRecord(source, name, {
    format: 'folder',
    dir,
    description: settings.description ?? '',
    tools: toolList(settings.tools),
    allowedTools: toolList(settings.allowedTools),
    model: settings.model,
  })
}

// Single-file agent, or null when the file has no `name` and `description` header (a README, a plain note).
async function readFileAgent(file, source) {
  const parsed = parseFrontMatter(await readFile(file, 'utf8'))
  if (!parsed || typeof parsed.header.name !== 'string' || typeof parsed.header.description !== 'string') return null
  const name = parsed.header.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!NAME.test(name)) return null
  return agentRecord(source, name, {
    format: 'file',
    file,
    description: parsed.header.description.slice(0, 300),
    allowedTools: toolList(parsed.header.tools),
    model: typeof parsed.header.model === 'string' && parsed.header.model !== 'inherit' ? parsed.header.model : undefined,
  })
}

const SKIP_DIRS = new Set(['node_modules'])

// Every agent under `root`. Local roots are looked at one level deep; source checkouts a few levels, since
// collections group agents in subfolders. A folder with a CLAUDE.md is one agent and is not searched further.
async function scanRoot(root, source) {
  const agents = new Map()
  const add = (agent) => agent && !agents.has(agent.name) && agents.set(agent.name, agent)
  async function walk(dir, depth) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (NAME.test(entry.name) && (await isFile(path.join(full, 'CLAUDE.md')))) add(await readFolderAgent(full, source))
        else if (depth > 0) await walk(full, depth - 1)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        add(await readFileAgent(full, source).catch(() => null))
      }
    }
  }
  await walk(root, source ? 3 : 0)
  return agents
}

// All agents by name: local roots in order (first one wins), then each source under its prefix.
async function allAgents() {
  const agents = new Map()
  for (const root of AGENT_ROOTS) {
    for (const [name, agent] of await scanRoot(root, null)) if (!agents.has(name)) agents.set(name, agent)
  }
  for (const source of await listSources()) {
    for (const [name, agent] of await scanRoot(sourceRoot(source), source)) agents.set(name, agent)
  }
  return agents
}

export async function findAgent(name) {
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) throw new HttpError(400, 'invalid "agent"')
  const agent = (await allAgents()).get(name)
  if (!agent) throw new HttpError(404, `unknown agent "${name}"`)
  return agent
}

export async function listAgents() {
  const list = []
  for (const agent of (await allAgents()).values()) {
    const schemas = agent.dir ? await readdir(path.join(agent.dir, 'schemas')).catch(() => []) : []
    list.push({
      name: agent.name,
      description: agent.description,
      source: agent.source,
      trusted: agent.trusted,
      format: agent.format,
      schemas: schemas.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)),
    })
  }
  return list
}

// Names an agent's .env may not set: they would break the server's own process or its login.
const RESERVED_ENV = /^(PATH|HOME|USER|SHELL|API_TOKEN|NODE_OPTIONS|CLAUDE_\w*|ANTHROPIC_\w*|AGENT_\w*)$/i

// Variables from the agent's private `.env` (KEY=VALUE lines, # comments, optional quotes). They are given to that
// agent's Claude process only, so its scripts and .mcp.json can use secrets that no other agent sees.
export async function readAgentEnv(agent) {
  const text = await readFile(path.join(agent.dataDir, '.env'), 'utf8').catch(() => '')
  const env = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!match || RESERVED_ENV.test(match[1])) continue
    env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return env
}

// The agent's instructions as text, for runs that do not happen inside the agent's folder.
export async function readInstructions(agent) {
  if (agent.format === 'folder') return readFile(path.join(agent.dir, 'CLAUDE.md'), 'utf8')
  return parseFrontMatter(await readFile(agent.file, 'utf8')).body
}

// `output_schema` is a JSON Schema (object, or its JSON text in a form field) or the name of a file in the agent's schemas/.
export async function resolveSchema(value, agent) {
  if (value == null || value === '') return null
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value !== 'string') throw new HttpError(400, 'invalid "output_schema"')
  if (value.trimStart().startsWith('{')) {
    try {
      return JSON.stringify(JSON.parse(value))
    } catch {
      throw new HttpError(400, '"output_schema" is not valid JSON')
    }
  }
  if (!/^[\w-]+$/.test(value)) throw new HttpError(400, 'invalid "output_schema"')
  if (!agent) throw new HttpError(400, 'a named "output_schema" needs an "agent"')
  const text = await readFile(path.join(agent.dir ?? '', 'schemas', `${value}.json`), 'utf8').catch(() => {
    throw new HttpError(404, `agent "${agent.name}" has no schema "${value}"`)
  })
  return JSON.stringify(JSON.parse(text))
}

// Private folders used to sit directly in DATA_DIR; they now live in DATA_DIR/data so they cannot clash with other state.
export async function migrateDataDirs() {
  for (const entry of await readdir(DATA_DIR, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || ['data', 'sources', 'run'].includes(entry.name)) continue
    const target = path.join(DATA_ROOT, entry.name)
    if (await stat(target).then(() => true, () => false)) continue
    await mkdir(DATA_ROOT, { recursive: true })
    await rename(path.join(DATA_DIR, entry.name), target)
    console.log(`moved agent data ${entry.name} to data/${entry.name}`)
  }
}
