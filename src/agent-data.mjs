// An agent's private folder (memory, personal settings) over HTTP, so its files can be read and written
// exactly, without going through Claude.
//
//   GET    /agents/<agent>/data            list the files
//   GET    /agents/<agent>/data/<file>     download one
//   PUT    /agents/<agent>/data/<file>     create or replace one; the request body is the file content
//   DELETE /agents/<agent>/data/<file>     delete one
//
// `.env` holds the agent's secrets (see readAgentEnv): it can be written and deleted here, but never read back.
import { createReadStream } from 'node:fs'
import { mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { findAgent } from './agents.mjs'
import { MAX_BODY_BYTES } from './config.mjs'
import { HttpError, send } from './http.mjs'

const SECRETS_FILE = '.env'
const TEXT_TYPES = { '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv' }

// Maps the <file> part of the URL to a path inside the agent's folder, or throws.
async function resolveDataPath(agent, rawPath) {
  let segments
  try {
    segments = rawPath.split('/').map(decodeURIComponent)
  } catch {
    throw new HttpError(400, 'invalid file path')
  }
  // no hidden files (except the secrets file) and no way out of the folder, including via symlinks in a parent folder
  const hidden = (s) => s.startsWith('.') && !(segments.length === 1 && s === SECRETS_FILE)
  if (segments.some((s) => !s || hidden(s) || s.includes('/') || s.includes('\\'))) {
    throw new HttpError(400, 'invalid file path')
  }
  await mkdir(agent.dataDir, { recursive: true })
  const root = await realpath(agent.dataDir)
  const file = path.join(root, ...segments)
  let existing = path.dirname(file)
  while (!(await stat(existing).catch(() => null))) existing = path.dirname(existing)
  const parent = await realpath(existing)
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new HttpError(400, 'invalid file path')
  return file
}

async function listData(agent) {
  const files = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name)
      const secret = dir === agent.dataDir && entry.name === SECRETS_FILE
      if (entry.name.startsWith('.') && !secret) continue
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        const info = await stat(full)
        const name = path.relative(agent.dataDir, full).split(path.sep).join('/')
        files.push({ name, size: info.size, modified: info.mtime.toISOString(), ...(secret && { secret: true }) })
      }
    }
  }
  await walk(agent.dataDir)
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

export async function handleAgentData(req, res, agentName, rawPath) {
  const agent = await findAgent(agentName)
  if (!rawPath) {
    if (req.method !== 'GET') throw new HttpError(405, 'name a file to change')
    return send(res, 200, { agent: agent.name, files: await listData(agent) })
  }
  const file = await resolveDataPath(agent, rawPath)

  if (req.method === 'PUT') {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    const content = Buffer.from(await new Response(Readable.toWeb(req)).arrayBuffer())
    if (content.length > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    if ((await stat(file).catch(() => null))?.isDirectory()) throw new HttpError(400, 'that path is a folder')
    await mkdir(path.dirname(file), { recursive: true })
    // write then rename, so a request reading the file never sees half of it
    await writeFile(`${file}.tmp`, content)
    await rename(`${file}.tmp`, file)
    const name = path.relative(await realpath(agent.dataDir), file).split(path.sep).join('/')
    return send(res, 200, { agent: agent.name, name, size: content.length })
  }

  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) throw new HttpError(404, 'file not found')
  if (req.method === 'DELETE') {
    await rm(file)
    return send(res, 200, { ok: true })
  }
  if (req.method !== 'GET') throw new HttpError(405, 'use GET, PUT or DELETE')
  if (path.basename(file) === SECRETS_FILE) throw new HttpError(403, 'the secrets file can be replaced or deleted, not read')
  res.writeHead(200, {
    'content-type': TEXT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
  })
  createReadStream(file).pipe(res)
}
