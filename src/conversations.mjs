// Conversations: a caller-chosen key that stands for a Claude session, so callers don't have to store session ids.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AGENT_NAME } from './agents.mjs'
import { DATA_DIR } from './config.mjs'
import { HttpError, send } from './http.mjs'

const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json')
export const CONVERSATION_KEY = /^[\w:.@-]{1,200}$/

let conversations = null
const busyConversations = new Set()

async function loadConversations() {
  conversations ??= await readFile(CONVERSATIONS_FILE, 'utf8').then(JSON.parse, () => ({}))
  return conversations
}

async function saveConversations() {
  await mkdir(DATA_DIR, { recursive: true })
  // write then rename, so a crash never leaves a half-written index
  await writeFile(`${CONVERSATIONS_FILE}.tmp`, JSON.stringify(conversations, null, 2))
  await rename(`${CONVERSATIONS_FILE}.tmp`, CONVERSATIONS_FILE)
}

const conversationId = (agentName, key) => `${agentName ?? '_'}/${key}`

// True while a request for this key is being answered.
export const isConversationBusy = (agentName, key) => busyConversations.has(conversationId(agentName, key))

// Calls `run(session)` with the session stored for this key, or a new one, and remembers the session Claude reports back.
// Returns {result, restarted}.
export async function runInConversation(agentName, key, run) {
  const id = conversationId(agentName, key)
  if (busyConversations.has(id)) throw new HttpError(409, `conversation "${key}" is still answering the previous request`)
  busyConversations.add(id)
  try {
    const index = await loadConversations()
    const known = index[id]
    let restarted = false
    const result = await (known ? run({ resume: known }) : run({ start: randomUUID() })).catch((err) => {
      // the stored session is gone (e.g. Claude's history was deleted): start the conversation again
      if (!known || !/no conversation found/i.test(err.message)) throw err
      restarted = true
      return run({ start: randomUUID() })
    })
    if (result.session_id && index[id] !== result.session_id) {
      index[id] = result.session_id
      await saveConversations()
    }
    return { result, restarted }
  } finally {
    busyConversations.delete(id)
  }
}

export async function handleForgetConversation(res, agentName, key) {
  if (!(agentName === '_' || AGENT_NAME.test(agentName)) || !CONVERSATION_KEY.test(key)) {
    throw new HttpError(400, 'invalid conversation path')
  }
  const index = await loadConversations()
  const id = `${agentName}/${key}`
  if (!(id in index)) throw new HttpError(404, 'conversation not found')
  delete index[id]
  await saveConversations()
  send(res, 200, { ok: true })
}
