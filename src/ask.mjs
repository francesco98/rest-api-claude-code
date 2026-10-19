// POST /ask: one prompt in, Claude's answer and the files it touched out.
// The two halves, prepareAsk and executeAsk, are also what an asynchronous job runs (jobs.mjs).
import { randomUUID } from 'node:crypto'
import { findAgent, resolveSchema } from './agents.mjs'
import { runClaude } from './claude.mjs'
import { contextDir, ensureContext, recordSession, sessionBelongsTo } from './context.mjs'
import { CONVERSATION_KEY, runInConversation } from './conversations.mjs'
import { HttpError, parseBody, send } from './http.mjs'
import { listChangedFiles, saveUploads } from './workspace.mjs'

// Reads and checks a request and saves its attachments. Everything that can be refused is refused here,
// before Claude is started.
export async function prepareAsk(req) {
  const body = await parseBody(req)
  const { prompt, sessionId, files } = body
  // an empty form field means "not set"
  const conversation = body.conversation || null
  if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, '"prompt" is required')
  if (sessionId != null && !/^[\w-]+$/.test(sessionId)) throw new HttpError(400, 'invalid "session_id"')
  if (conversation != null) {
    // a key of dots only would name a folder outside the conversation's own
    if (typeof conversation !== 'string' || !CONVERSATION_KEY.test(conversation) || /^\.+$/.test(conversation)) {
      throw new HttpError(400, 'invalid "conversation"')
    }
    if (sessionId != null) throw new HttpError(400, 'send either "conversation" or "session_id", not both')
  }
  const agent = body.agent ? await findAgent(body.agent) : null
  const schema = await resolveSchema(body.outputSchema, agent)

  // The run's folder. A new session gets its id here, so its attachments can be saved in its folder before it starts.
  // A session can only be resumed in the context it was started in (with the same agent, and not one that belongs
  // to a conversation); its folder comes back even if cleanup removed it.
  let session = null
  let dir
  if (conversation != null) {
    dir = await ensureContext(contextDir({ agent, conversation }))
  } else if (sessionId != null) {
    dir = contextDir({ agent, sessionId })
    if (!(await sessionBelongsTo(sessionId, dir))) {
      throw new HttpError(404, `no session "${sessionId}"${agent ? ` for agent "${agent.name}"` : ' without an agent'}`)
    }
    await ensureContext(dir)
    session = { resume: sessionId }
  } else {
    const id = randomUUID()
    dir = await ensureContext(contextDir({ agent, sessionId: id }))
    session = { start: id }
  }

  // 1s of slack: some filesystems round mtimes down
  const startedAt = Date.now() - 1000
  let fullPrompt = prompt
  let uploadId = null
  if (files.length > 0) {
    const upload = await saveUploads(files, dir)
    uploadId = upload.jobId
    fullPrompt +=
      `\n\nThe user attached these files:\n${upload.saved.map((p) => `- ${p}`).join('\n')}\n` +
      `If you change a file, edit it in place. Put any new files you create in ${upload.dir}.`
  }
  return {
    prompt: fullPrompt, session, conversation, agent, schema, uploadId, contextDir: dir, startedAt,
    callbackUrl: body.callbackUrl, callbackHeaders: body.callbackHeaders,
  }
}

// Runs Claude for a prepared request and returns the response body.
export async function executeAsk(request, { signal, timeoutMs } = {}) {
  const { prompt, session, conversation, agent, schema, uploadId, contextDir, startedAt } = request
  const run = (session) => runClaude(prompt, { session, agent, schema, contextDir, signal, timeoutMs })
  // a new session belongs to this context from the start, so it can be resumed even if this run fails
  if (session?.start) await recordSession(session.start, contextDir)
  const { result, restarted } =
    conversation == null
      ? { result: await run(session).catch((err) => {
          // a session Claude no longer has
          if (session.resume && /no conversation found/i.test(err.message)) throw new HttpError(404, `no session "${session.resume}"`)
          throw err
        }), restarted: false }
      : await runInConversation(agent?.name, conversation, run)
  await recordSession(result.session_id, contextDir)

  return {
    result: result.result,
    // the answer as an object when "output_schema" was sent
    output: schema ? (result.structured_output ?? null) : null,
    is_error: result.is_error ?? false,
    session_id: result.session_id,
    agent: agent?.name ?? null,
    conversation,
    ...(restarted && { conversation_restarted: true }),
    // the folder under uploads/ that holds this request's attachments; `job_id` is its former name
    upload_id: uploadId,
    job_id: uploadId,
    files: await listChangedFiles(startedAt, contextDir),
  }
}

export async function handleAsk(req, res) {
  send(res, 200, await executeAsk(await prepareAsk(req)))
}
