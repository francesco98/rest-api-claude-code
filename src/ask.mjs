// POST /ask: one prompt in, Claude's answer and the files it touched out.
// The two halves, prepareAsk and executeAsk, are also what an asynchronous job runs (jobs.mjs).
import { findAgent, resolveSchema } from './agents.mjs'
import { runClaude } from './claude.mjs'
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
    if (typeof conversation !== 'string' || !CONVERSATION_KEY.test(conversation)) throw new HttpError(400, 'invalid "conversation"')
    if (sessionId != null) throw new HttpError(400, 'send either "conversation" or "session_id", not both')
  }
  const agent = body.agent ? await findAgent(body.agent) : null
  const schema = await resolveSchema(body.outputSchema, agent)

  // 1s of slack: some filesystems round mtimes down
  const startedAt = Date.now() - 1000
  let fullPrompt = prompt
  let uploadId = null
  let uploadDir
  if (files.length > 0) {
    const upload = await saveUploads(files)
    uploadId = upload.jobId
    uploadDir = upload.dir
    fullPrompt +=
      `\n\nThe user attached these files:\n${upload.saved.map((p) => `- ${p}`).join('\n')}\n` +
      `If you change a file, edit it in place. Put any new files you create in ${upload.dir}.`
  }
  return {
    prompt: fullPrompt, sessionId, conversation, agent, schema, uploadId, uploadDir, startedAt,
    callbackUrl: body.callbackUrl, callbackHeaders: body.callbackHeaders,
  }
}

// Runs Claude for a prepared request and returns the response body.
export async function executeAsk(request, { signal, timeoutMs } = {}) {
  const { prompt, sessionId, conversation, agent, schema, uploadId, uploadDir, startedAt } = request
  const run = (session) => runClaude(prompt, { session, agent, schema, uploadDir, signal, timeoutMs })
  const { result, restarted } =
    conversation == null
      ? { result: await run({ resume: sessionId }), restarted: false }
      : await runInConversation(agent?.name, conversation, run)

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
    files: await listChangedFiles(startedAt),
  }
}

export async function handleAsk(req, res) {
  send(res, 200, await executeAsk(await prepareAsk(req)))
}
