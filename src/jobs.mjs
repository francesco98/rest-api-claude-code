// Asynchronous jobs: the same request as POST /ask, answered at once with an id. The result is fetched
// later, or sent to a webhook. For runs that take longer than a caller wants to hold a connection open.
//
//   POST   /jobs          body of /ask + {callback_url?, callback_headers?}  ->  202 {id, status, status_url}
//   GET    /jobs          recent jobs, without their responses (?status= filters)
//   GET    /jobs/<id>     one job; `response` is what /ask would have returned
//   DELETE /jobs/<id>     cancel a queued or running job, or remove a finished one
//
// At most MAX_CONCURRENT_JOBS run at once; the rest wait as "queued". Jobs are kept in DATA_DIR/jobs.json, so
// results survive a restart. A job that was not finished when the server stopped cannot be resumed and is failed.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { executeAsk, prepareAsk } from './ask.mjs'
import { DATA_DIR, JOB_RETENTION_MS, JOB_TIMEOUT_MS, MAX_CONCURRENT_JOBS } from './config.mjs'
import { isConversationBusy } from './conversations.mjs'
import { HttpError, send } from './http.mjs'

const JOBS_FILE = path.join(DATA_DIR, 'jobs.json')
const FINAL = new Set(['succeeded', 'failed', 'cancelled'])
const MAX_LISTED_JOBS = 100
// waits before the second and third webhook attempt
const CALLBACK_RETRY_MS = [2000, 6000]
const CALLBACK_TIMEOUT_MS = 15_000

const jobs = new Map() // id -> job record, as stored
const runtime = new Map() // id -> {request, controller}, only for jobs that have not finished
const queue = [] // ids waiting for a slot, oldest first
let running = 0

// Writes are chained so two changes never interleave in the file.
let saving = Promise.resolve()
function save() {
  saving = saving.then(async () => {
    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(`${JOBS_FILE}.tmp`, JSON.stringify([...jobs.values()], null, 2))
    await rename(`${JOBS_FILE}.tmp`, JOBS_FILE)
  }).catch((err) => console.error(`could not save jobs: ${err.message}`))
  return saving
}

// What callers see: the stored record without the webhook headers, which may hold the receiver's credentials.
const view = ({ callback_headers, ...job }) => job

function finish(job, status, fields = {}) {
  Object.assign(job, { status, finished_at: new Date().toISOString(), ...fields })
  runtime.delete(job.id)
  save()
  deliver(job)
}

// Sends the finished job to its webhook, if it has one. A failed delivery never changes the job's status.
async function deliver(job) {
  if (!job.callback_url) return
  job.callback = { delivered: false, attempts: 0 }
  for (let attempt = 0; attempt <= CALLBACK_RETRY_MS.length; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, CALLBACK_RETRY_MS[attempt - 1]))
    job.callback.attempts = attempt + 1
    try {
      const res = await fetch(job.callback_url, {
        method: 'POST',
        headers: { ...job.callback_headers, 'content-type': 'application/json' },
        body: JSON.stringify(view(job)),
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`the receiver answered ${res.status}`)
      job.callback = { delivered: true, attempts: attempt + 1 }
      break
    } catch (err) {
      job.callback.last_error = err.message
    }
  }
  if (!job.callback.delivered) console.error(`webhook for job ${job.id} not delivered: ${job.callback.last_error}`)
  save()
}

// Starts queued jobs while there are free slots.
function pump() {
  while (running < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const job = jobs.get(queue.shift())
    const run = runtime.get(job?.id)
    if (!job || !run) continue
    running++
    Object.assign(job, { status: 'running', started_at: new Date().toISOString() })
    save()
    executeAsk(run.request, { signal: run.controller.signal, timeoutMs: JOB_TIMEOUT_MS })
      .then(
        (response) => finish(job, 'succeeded', { response }),
        (err) => {
          if (err.cancelled) return finish(job, 'cancelled')
          if (!(err instanceof HttpError)) console.error(err)
          finish(job, 'failed', { error: { status: err.status ?? 500, message: err.message } })
        },
      )
      .finally(() => {
        running--
        pump()
      })
  }
}

function checkCallback(url, headers) {
  if (url == null || url === '') return {}
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new HttpError(400, 'invalid "callback_url"')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, '"callback_url" must be an http(s) URL')
  // a form field carries the headers as JSON text
  let list = headers
  if (typeof list === 'string' && list.trim()) {
    try {
      list = JSON.parse(list)
    } catch {
      throw new HttpError(400, '"callback_headers" is not valid JSON')
    }
  }
  if (list == null || list === '') return { callback_url: url }
  const ok = typeof list === 'object' && !Array.isArray(list) &&
    Object.entries(list).every(([name, value]) => /^[\w-]+$/.test(name) && typeof value === 'string')
  if (!ok) throw new HttpError(400, '"callback_headers" must be an object of header names and text values')
  return { callback_url: url, callback_headers: list }
}

export async function handleSubmitJob(req, res) {
  const request = await prepareAsk(req)
  const callback = checkCallback(request.callbackUrl, request.callbackHeaders)
  const agentName = request.agent?.name ?? null
  if (request.conversation != null) {
    // one request at a time per conversation, whether it is being answered now or is a job still to run
    const waiting = [...jobs.values()].some(
      (j) => !FINAL.has(j.status) && j.conversation === request.conversation && j.agent === agentName,
    )
    if (waiting || isConversationBusy(agentName, request.conversation)) {
      throw new HttpError(409, `conversation "${request.conversation}" is still answering the previous request`)
    }
  }
  const job = {
    id: randomUUID(),
    status: 'queued',
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    agent: agentName,
    conversation: request.conversation,
    ...callback,
  }
  jobs.set(job.id, job)
  runtime.set(job.id, { request, controller: new AbortController() })
  queue.push(job.id)
  save()
  pump()
  send(res, 202, { id: job.id, status: job.status, status_url: `/jobs/${job.id}` })
}

function findJob(id) {
  const job = jobs.get(id)
  if (!job) throw new HttpError(404, 'job not found')
  return job
}

export function handleGetJob(res, id) {
  send(res, 200, view(findJob(id)))
}

export function handleListJobs(res, status) {
  const list = [...jobs.values()]
    .filter((job) => !status || job.status === status)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_LISTED_JOBS)
    .map(({ response, ...job }) => view(job))
  send(res, 200, { jobs: list })
}

export function handleDeleteJob(res, id) {
  const job = findJob(id)
  if (FINAL.has(job.status)) {
    jobs.delete(id)
    save()
    return send(res, 200, { ok: true, removed: true })
  }
  if (job.status === 'queued') {
    queue.splice(queue.indexOf(id), 1)
    finish(job, 'cancelled')
  } else {
    // the run ends through its abort signal and is recorded as cancelled when the process has gone
    runtime.get(id)?.controller.abort()
  }
  send(res, 200, { ok: true, cancelled: true })
}

function prune() {
  let removed = 0
  for (const job of jobs.values()) {
    if (FINAL.has(job.status) && Date.now() - Date.parse(job.finished_at) > JOB_RETENTION_MS) {
      jobs.delete(job.id)
      removed++
    }
  }
  if (removed > 0) save()
}

// Loads the stored jobs, fails the ones a previous server process left unfinished, and keeps the list pruned.
export async function startJobs() {
  const stored = await readFile(JOBS_FILE, 'utf8').then(JSON.parse, () => [])
  for (const job of stored) jobs.set(job.id, job)
  for (const job of jobs.values()) {
    if (!FINAL.has(job.status)) {
      finish(job, 'failed', { error: { status: 503, message: 'the server restarted before the job finished' } })
    }
  }
  prune()
  setInterval(prune, 15 * 60 * 1000).unref()
}
