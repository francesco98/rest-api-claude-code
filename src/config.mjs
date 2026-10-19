// Every setting the server reads from the environment.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PORT = Number(process.env.PORT ?? 8080)
export const API_TOKEN = process.env.API_TOKEN ?? ''
export const WORKSPACE = process.env.WORKSPACE ?? '/workspace'
export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude'
// Claude's login, settings and session transcripts; hidden from every run's Bash
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? '/home/node', '.claude')
// The Bash sandbox reuses the container's /proc, because an unprivileged container cannot mount a fresh one.
// Set to false when the container may (see the README), for a sandbox that also hides the container's processes.
export const SANDBOX_NESTED = process.env.SANDBOX_NESTED !== 'false'
// Hosts Bash may reach in every run but an untrusted agent's (comma-separated, `*.example.com` allowed); empty: none.
// A trusted agent adds its own in agent.json (`allowedDomains`).
export const SANDBOX_ALLOWED_DOMAINS = (process.env.SANDBOX_ALLOWED_DOMAINS ?? '').split(',').map((d) => d.trim()).filter(Boolean)
export const ALLOWED_TOOLS = process.env.CLAUDE_ALLOWED_TOOLS ?? 'Read,Edit,Write,Glob,Grep,Bash'
export const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_SECONDS ?? 600) * 1000
// Asynchronous jobs (POST /jobs): how long one may run, how many run at once, and how long a finished one is kept
export const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_SECONDS || 3600) * 1000
export const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 2))
export const JOB_RETENTION_MS = Number(process.env.JOB_RETENTION_HOURS || 24) * 60 * 60 * 1000
// Workspace files not modified for this long are deleted, uploads and Claude's output alike; 0 keeps them forever.
// Default 24h with the Docker volume, 0 when PROJECT_DIR is a host folder, so a real project is never cleaned
export const RETENTION_MS = Number(process.env.WORKSPACE_RETENTION_HOURS || (process.env.PROJECT_DIR ? 0 : 24)) * 60 * 60 * 1000
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
