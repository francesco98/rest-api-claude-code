// Every setting the server reads from the environment.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PORT = Number(process.env.PORT ?? 8080)
export const API_TOKEN = process.env.API_TOKEN ?? ''
export const WORKSPACE = process.env.WORKSPACE ?? '/workspace'
export const UPLOADS = path.join(WORKSPACE, 'uploads')
export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude'
export const ALLOWED_TOOLS = process.env.CLAUDE_ALLOWED_TOOLS ?? 'Read,Edit,Write,Glob,Grep,Bash'
export const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_SECONDS ?? 600) * 1000
// Asynchronous jobs (POST /jobs): how long one may run, how many run at once, and how long a finished one is kept
export const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_SECONDS || 3600) * 1000
export const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 2))
export const JOB_RETENTION_MS = Number(process.env.JOB_RETENTION_HOURS || 24) * 60 * 60 * 1000
// Workspace files not modified for this long are deleted, uploads and Claude's output alike; 0 keeps them forever
export const RETENTION_MS = Number(process.env.WORKSPACE_RETENTION_HOURS || 24) * 60 * 60 * 1000
export const MAX_BODY_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024
// An agent is a folder with a CLAUDE.md. AGENTS_DIR (optional) is searched before the agents shipped next to server.mjs
export const AGENT_ROOTS = [
  process.env.AGENTS_DIR,
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents'),
].filter(Boolean)
// Per-agent private folders (memory, personal settings) and the conversation index; kept out of the workspace so cleanup never touches them
export const DATA_DIR = process.env.DATA_DIR ?? '/agent-data'
// The only tools an agent from an untrusted source gets, whatever it asks for: no shell and no network
export const UNTRUSTED_TOOLS = process.env.UNTRUSTED_TOOLS ?? 'Read,Glob,Grep,Write,Edit'
