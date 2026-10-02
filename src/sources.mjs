// Agent sources: git repositories whose agents are added to the local ones, under the prefix `<source>/`.
//
// The list is DATA_DIR/sources.json, edited through PUT /agents/sources. Each source is fetched into
// DATA_DIR/sources/<name>/checkout. A source that is not `trusted` must be pinned to a commit, and its
// agents only contribute instructions (see claude.mjs).
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { DATA_DIR } from './config.mjs'
import { HttpError, readJson, send } from './http.mjs'

const exec = promisify(execFile)
const SOURCES_FILE = path.join(DATA_DIR, 'sources.json')
const SOURCES_DIR = path.join(DATA_DIR, 'sources')
const SOURCE_NAME = /^[a-z0-9][a-z0-9_-]*$/
const COMMIT = /^[0-9a-f]{40}$/
const GIT_TIMEOUT_MS = 120_000

let sources = null

export async function listSources() {
  sources ??= await readFile(SOURCES_FILE, 'utf8').then((text) => JSON.parse(text).sources ?? [], () => [])
  return sources
}

// Where a source's agents are: its checkout, narrowed to the configured sub-folder.
export const sourceRoot = (source) => path.join(SOURCES_DIR, source.name, 'checkout', source.path)

const statusFile = (name) => path.join(SOURCES_DIR, name, 'status.json')
const readStatus = (name) => readFile(statusFile(name), 'utf8').then(JSON.parse, () => ({}))

// Checks a list sent by a caller and returns it in the stored form, or throws 400 naming the problem.
function validateSources(input) {
  if (!Array.isArray(input)) throw new HttpError(400, '"sources" must be a list')
  const seen = new Set()
  return input.map((entry, i) => {
    const fail = (message) => {
      throw new HttpError(400, `source ${entry?.name ?? i + 1}: ${message}`)
    }
    if (entry == null || typeof entry !== 'object') fail('must be an object')
    const { name, git, ref, tokenEnv } = entry
    const trusted = entry.trusted === true
    const subPath = entry.path ?? ''
    if (typeof name !== 'string' || !SOURCE_NAME.test(name)) fail('"name" may contain lowercase letters, digits, - and _')
    if (name === 'local' || seen.has(name)) fail('"name" is already used')
    seen.add(name)
    if (typeof git !== 'string' || !/^(https|file):\/\/\S+$/.test(git)) fail('"git" must be an https:// URL')
    if (/^https:\/\/[^/]*@/.test(git)) fail('"git" must not contain credentials; use "tokenEnv"')
    if (typeof ref !== 'string' || !/^[\w./-]+$/.test(ref) || ref.startsWith('-')) fail('"ref" must be a branch, tag or commit')
    if (!trusted && !COMMIT.test(ref)) fail('a source that is not trusted must pin "ref" to a full 40-character commit')
    if (typeof subPath !== 'string' || path.isAbsolute(subPath) || subPath.split(/[\\/]/).includes('..')) {
      fail('"path" must be a folder inside the repository')
    }
    if (tokenEnv != null && (typeof tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv))) {
      fail('"tokenEnv" must be the name of an environment variable')
    }
    return { name, git, ref, path: path.normalize(subPath || '.'), ...(tokenEnv && { tokenEnv }), trusted }
  })
}

const git = (cwd, args, extra = []) =>
  exec('git', [...extra, ...args], { cwd, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

// Fetches one source into a fresh folder and swaps it in, so readers see the old or the new checkout, never half of one.
async function syncSource(source) {
  const base = path.join(SOURCES_DIR, source.name)
  const fresh = path.join(base, 'checkout.new')
  const live = path.join(base, 'checkout')
  const previous = await readStatus(source.name)
  try {
    await rm(fresh, { recursive: true, force: true })
    await mkdir(fresh, { recursive: true })
    // the token travels as a header for this one command and is not written to the checkout
    const token = source.tokenEnv ? process.env[source.tokenEnv] : null
    if (source.tokenEnv && !token) throw new Error(`environment variable ${source.tokenEnv} is not set`)
    const auth = token
      ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
      : []
    await git(fresh, ['init', '--quiet'])
    await git(fresh, ['fetch', '--quiet', '--depth', '1', source.git, source.ref], auth)
    await git(fresh, ['checkout', '--quiet', 'FETCH_HEAD'])
    const commit = (await git(fresh, ['rev-parse', 'HEAD'])).stdout.trim()
    if (!source.trusted && commit !== source.ref) throw new Error(`fetched ${commit}, not the pinned commit`)
    await rm(path.join(fresh, '.git'), { recursive: true, force: true })
    await rm(`${live}.old`, { recursive: true, force: true })
    await rename(live, `${live}.old`).catch(() => {})
    await rename(fresh, live)
    await rm(`${live}.old`, { recursive: true, force: true })
    await writeFile(statusFile(source.name), JSON.stringify({ commit, syncedAt: new Date().toISOString() }))
  } catch (err) {
    // keep serving the previous checkout and say why the new one failed
    const lines = String(err.stderr || err.message).trim().split('\n')
    const message = (lines.find((line) => /^(fatal|error):/.test(line)) ?? lines.pop()).slice(0, 300)
    console.error(`could not sync source ${source.name}: ${message}`)
    await rm(fresh, { recursive: true, force: true })
    await mkdir(base, { recursive: true })
    await writeFile(statusFile(source.name), JSON.stringify({ ...previous, error: message, failedAt: new Date().toISOString() }))
  }
}

// One sync at a time; a second request waits for the first.
let syncing = Promise.resolve()
export function syncSources(only) {
  syncing = syncing.then(async () => {
    const list = await listSources()
    for (const source of list) if (!only || source.name === only) await syncSource(source)
    // drop checkouts of sources that are no longer listed
    for (const entry of await readdir(SOURCES_DIR, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && !list.some((s) => s.name === entry.name)) {
        await rm(path.join(SOURCES_DIR, entry.name), { recursive: true, force: true })
      }
    }
  })
  return syncing
}

async function sourcesView() {
  return Promise.all((await listSources()).map(async (source) => ({ ...source, status: await readStatus(source.name) })))
}

export async function handleGetSources(res) {
  send(res, 200, { sources: await sourcesView() })
}

export async function handlePutSources(req, res) {
  const next = validateSources((await readJson(req)).sources)
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(`${SOURCES_FILE}.tmp`, JSON.stringify({ sources: next }, null, 2))
  await rename(`${SOURCES_FILE}.tmp`, SOURCES_FILE)
  sources = next
  await syncSources()
  send(res, 200, { sources: await sourcesView() })
}

export async function handleSync(req, res) {
  const only = (await readJson(req)).source
  if (only != null && !(await listSources()).some((s) => s.name === only)) throw new HttpError(404, `unknown source "${only}"`)
  await syncSources(only)
  send(res, 200, { sources: await sourcesView() })
}
