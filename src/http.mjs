// Small HTTP helpers shared by every handler.
import { timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { API_TOKEN, MAX_BODY_BYTES } from './config.mjs'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function authorized(req) {
  const given = Buffer.from(req.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${API_TOKEN}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// Body of a small JSON request; an empty body counts as {}.
export async function readJson(req) {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
  const text = await new Response(Readable.toWeb(req)).text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'body must be JSON')
  }
}

// Returns {prompt, sessionId, agent, conversation, outputSchema, callbackUrl, callbackHeaders, files: [File]}
// from a JSON or multipart body. The two callback fields are only used by POST /jobs.
export async function parseBody(req) {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'request body too large')
  }
  const contentType = req.headers['content-type'] ?? ''
  const request = new Request('http://localhost', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: Readable.toWeb(req),
    duplex: 'half',
  })
  if (contentType.startsWith('multipart/form-data')) {
    const form = await request.formData().catch(() => {
      throw new HttpError(400, 'invalid multipart body')
    })
    const files = [...form.values()].filter((v) => typeof v !== 'string' && v.name)
    return {
      prompt: form.get('prompt'),
      sessionId: form.get('session_id'),
      agent: form.get('agent'),
      conversation: form.get('conversation'),
      outputSchema: form.get('output_schema'),
      callbackUrl: form.get('callback_url'),
      callbackHeaders: form.get('callback_headers'),
      files,
    }
  }
  const json = await request.json().catch(() => {
    throw new HttpError(400, 'body must be JSON or multipart/form-data')
  })
  return {
    prompt: json.prompt,
    sessionId: json.session_id,
    agent: json.agent,
    conversation: json.conversation,
    outputSchema: json.output_schema,
    callbackUrl: json.callback_url,
    callbackHeaders: json.callback_headers,
    files: [],
  }
}
