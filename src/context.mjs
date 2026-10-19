// The context folder: the one part of the workspace a run can see. Each conversation and each session has its own,
// so no run reads what another agent, conversation or session left in the workspace.
//
//   agents/<agent>/conversations/<key>/     agents/<agent>/sessions/<session_id>/
//   conversations/<key>/                    sessions/<session_id>/          (no agent)
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR, WORKSPACE } from './config.mjs'
import { HttpError } from './http.mjs'

// Which context each session was started in. Claude Code resumes a session id from any working directory, so
// without this a session_id sent with another agent (or none) would carry one context's history into another.
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
let owners = null
let saving = Promise.resolve()

async function loadOwners() {
  owners ??= await readFile(SESSIONS_FILE, 'utf8').then(JSON.parse, () => ({}))
  return owners
}

export async function recordSession(sessionId, dir) {
  const index = await loadOwners()
  const owner = contextPrefix(dir)
  if (!sessionId || index[sessionId] === owner) return
  index[sessionId] = owner
  // writes are chained so two never interleave; write then rename, so a crash never leaves half a file
  saving = saving.then(async () => {
    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(`${SESSIONS_FILE}.tmp`, JSON.stringify(index))
    await rename(`${SESSIONS_FILE}.tmp`, SESSIONS_FILE)
  }).catch((err) => console.error(`could not save sessions: ${err.message}`))
  await saving
}

export const sessionBelongsTo = async (sessionId, dir) => (await loadOwners())[sessionId] === contextPrefix(dir)

// `source/name` becomes `source+name`, as for the agent's private folder
const agentFolder = (agent) => agent.name.replace('/', '+')

export function contextDir({ agent, conversation, sessionId }) {
  const base = agent ? path.join(WORKSPACE, 'agents', agentFolder(agent)) : WORKSPACE
  const dir = conversation != null ? path.join(base, 'conversations', conversation) : path.join(base, 'sessions', sessionId)
  // keys are checked by the caller; this keeps a key like `..` from ever naming a folder outside the context tree
  if (!dir.startsWith(base + path.sep) || path.basename(dir) !== (conversation ?? sessionId)) {
    throw new HttpError(400, 'invalid context')
  }
  return dir
}

export async function ensureContext(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

// The folder as /files/<path> names it, e.g. `agents/cv+cv-tailor/conversations/tg-1`
export const contextPrefix = (dir) => path.relative(WORKSPACE, dir).split(path.sep).join('/')
