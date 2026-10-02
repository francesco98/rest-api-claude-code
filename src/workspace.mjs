// The workspace: where uploads land, where Claude writes files, and what /files serves.
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { RETENTION_MS, UPLOADS, WORKSPACE } from './config.mjs'
import { HttpError } from './http.mjs'

// Saves a request's files to their own folder, uploads/<job_id>/. Returns {jobId, dir, saved: [paths]}.
export async function saveUploads(files) {
  const jobId = randomUUID()
  const dir = path.join(UPLOADS, jobId)
  await mkdir(dir, { recursive: true })
  const saved = []
  for (const file of files) {
    // basename() drops any directory part a client put in the filename
    const name = path.basename(file.name)
    await writeFile(path.join(dir, name), Buffer.from(await file.arrayBuffer()))
    saved.push(path.join(dir, name))
  }
  return { jobId, dir, saved }
}

const SKIP_DIRS = new Set(['node_modules'])
const MAX_LISTED_FILES = 200

// Workspace files written since `since` (ms): uploads plus anything Claude created or edited.
export async function listChangedFiles(since) {
  const found = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (found.length >= MAX_LISTED_FILES) return
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && (await stat(full)).mtimeMs >= since) found.push(full)
    }
  }
  await walk(WORKSPACE)
  return found.map((full) => {
    const rel = path.relative(WORKSPACE, full)
    return { name: rel, url: `/files/${rel.split(path.sep).map(encodeURIComponent).join('/')}` }
  })
}

// Maps the <path> part of /files/<path> to a real path inside the workspace, or throws.
async function resolveWorkspacePath(rawPath) {
  let segments
  try {
    segments = rawPath.split('/').map(decodeURIComponent)
  } catch {
    throw new HttpError(400, 'invalid file path')
  }
  // no hidden files (.git, .env) and no way out of the workspace, including via symlinks
  if (segments.some((s) => !s || s.startsWith('.') || s.includes('/') || s.includes('\\'))) {
    throw new HttpError(400, 'invalid file path')
  }
  const root = await realpath(WORKSPACE)
  const file = await realpath(path.join(root, ...segments)).catch(() => null)
  if (!file || !file.startsWith(root + path.sep)) throw new HttpError(404, 'file not found')
  return file
}

export async function handleDownload(res, rawPath) {
  const file = await resolveWorkspacePath(rawPath)
  const info = await stat(file)
  if (!info.isFile()) throw new HttpError(404, 'file not found')
  const name = path.basename(file)
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': info.size,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  })
  createReadStream(file).pipe(res)
}

// Deletes every workspace file not modified for RETENTION_MS, and folders that are old and empty.
async function cleanWorkspace(dir = WORKSPACE) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) await cleanWorkspace(full)
      if (Date.now() - (await lstat(full)).mtimeMs <= RETENTION_MS) continue
      if (entry.isDirectory()) {
        await rmdir(full).catch(() => {}) // only succeeds when the folder is empty
      } else {
        await rm(full, { force: true })
        console.log(`removed expired file ${path.relative(WORKSPACE, full)}`)
      }
    } catch (err) {
      console.error(`could not clean ${full}: ${err.message}`)
    }
  }
}

// Cleans now and every 15 minutes, unless retention is switched off.
export function startCleanup() {
  if (RETENTION_MS <= 0) return
  cleanWorkspace()
  setInterval(cleanWorkspace, 15 * 60 * 1000).unref()
}
