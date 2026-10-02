// Minimal HTTP adapter in front of the Claude Code CLI (`claude -p`).
//
//   POST /ask                     JSON {prompt, session_id?, agent?, conversation?, output_schema?}
//                                 or multipart (the same fields, plus files)
//   POST /jobs                    the same request, answered at once with a job id (see src/jobs.mjs)
//   GET  /jobs, GET|DELETE /jobs/<id>   list, read, cancel or remove jobs
//   GET  /files/<path>            download a workspace file (the `url` values returned by /ask)
//   GET  /agents                  list the agents that `agent` can name
//   GET  /agents/sources          the git repositories agents are pulled from, with their sync status
//   PUT  /agents/sources          replace that list {sources: [...]} and sync
//   POST /agents/sync             fetch the sources again ({source?} for one)
//   GET|PUT|DELETE /agents/<agent>/data[/<file>]   read and write an agent's private files
//   DELETE /conversations/<agent>/<key>   forget a conversation (`_` as agent when none was used)
//   GET  /health
//
// Every request except /health needs `Authorization: Bearer $API_TOKEN`.
// This file is only the route table; each topic lives in its own module under src/.
import { createServer } from 'node:http'
import { handleAgentData } from './src/agent-data.mjs'
import { listAgents, migrateDataDirs } from './src/agents.mjs'
import { handleAsk } from './src/ask.mjs'
import { stopRunningClaude } from './src/claude.mjs'
import { API_TOKEN, PORT, WORKSPACE } from './src/config.mjs'
import { handleForgetConversation } from './src/conversations.mjs'
import { HttpError, authorized, send } from './src/http.mjs'
import { handleDeleteJob, handleGetJob, handleListJobs, handleSubmitJob, startJobs } from './src/jobs.mjs'
import { handleGetSources, handlePutSources, handleSync, syncSources } from './src/sources.mjs'
import { handleDownload, startCleanup } from './src/workspace.mjs'

if (!API_TOKEN) {
  console.error('API_TOKEN is not set: refusing to start an unauthenticated agent endpoint')
  process.exit(1)
}

startCleanup()
await migrateDataDirs()
await startJobs()
// in the background: built-in agents are served straight away, sources as soon as they are fetched
syncSources().catch((err) => console.error(`source sync failed: ${err.message}`))

const server = createServer(async (req, res) => {
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true })
    if (!authorized(req)) throw new HttpError(401, 'missing or wrong bearer token')

    if (req.method === 'POST' && pathname === '/ask') return await handleAsk(req, res)
    if (req.method === 'POST' && pathname === '/jobs') return await handleSubmitJob(req, res)
    if (req.method === 'GET' && pathname === '/jobs') return handleListJobs(res, searchParams.get('status'))
    const job = pathname.match(/^\/jobs\/([\w-]+)$/)
    if (req.method === 'GET' && job) return handleGetJob(res, job[1])
    if (req.method === 'DELETE' && job) return handleDeleteJob(res, job[1])
    if (req.method === 'GET' && pathname === '/agents') return send(res, 200, { agents: await listAgents() })
    if (req.method === 'GET' && pathname === '/agents/sources') return await handleGetSources(res)
    if (req.method === 'PUT' && pathname === '/agents/sources') return await handlePutSources(req, res)
    if (req.method === 'POST' && pathname === '/agents/sync') return await handleSync(req, res)
    const data = pathname.match(/^\/agents\/(.+?)\/data(?:\/(.*))?$/)
    if (data) return await handleAgentData(req, res, data[1], data[2])
    // the agent part is `name`, `source/name`, or `_` for conversations without an agent
    const forget = pathname.match(/^\/conversations\/(.+)\/([^/]+)$/)
    if (req.method === 'DELETE' && forget) {
      return await handleForgetConversation(res, forget[1], decodeURIComponent(forget[2]))
    }
    const download = pathname.match(/^\/files\/(.+)$/)
    if (req.method === 'GET' && download) return await handleDownload(res, download[1])
    throw new HttpError(404, 'not found')
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err)
    if (res.headersSent) return res.end()
    send(res, err.status ?? 500, { error: err.message })
  }
})

// A stopped server must not leave Claude runs behind: they would keep using the subscription with nobody to answer to.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopRunningClaude()
    process.exit(0)
  })
}

server.listen(PORT, () => console.log(`claude api listening on :${PORT}, workspace ${WORKSPACE}`))
