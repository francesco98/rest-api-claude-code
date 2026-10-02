# Agents

An agent is a folder. The API runs one when a request names it:

```bash
curl http://localhost:48271/ask \
  -H "Authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"agent": "triage", "output_schema": "ticket", "prompt": "I was charged twice, please refund me"}'
```

The server starts Claude Code inside that folder, so everything in it applies to the request. Nothing else is deployed: an agent has no process and no port.

## What goes in the folder

| File | Required | Purpose |
|---|---|---|
| `CLAUDE.md` | yes | The agent's instructions: what it is for, how it decides, what it must not do. Its presence is what makes the folder an agent |
| `agent.json` | no | `description` (shown by `GET /agents`), `tools` (the only built-in tools that exist for this agent), `allowedTools` (the tools that run without asking; replaces `CLAUDE_ALLOWED_TOOLS`), `model` |
| `scripts/` or any other files | no | Whatever the instructions refer to: shell scripts for fixed procedures, reference texts |
| `schemas/<name>.json` | no | JSON Schemas for structured answers. A request picks one with `"output_schema": "<name>"` |
| `.mcp.json` | no | MCP servers the agent may use as tools. Only these are loaded |
| `.claude/skills/` | no | Skills: longer procedures and their scripts, loaded when relevant |
| `data.example/` | no | Shows which private files the agent expects. Not read by the server |

The folder name is the agent's name: lowercase letters, digits, `-` and `_`.

Because this is Claude Code's own project layout, you can try an agent by hand: `cd agents/triage && claude`.

## Private data and memory

Agents in this repository are templates and hold no personal details. Each agent has a private folder on the server, `DATA_DIR/data/<name>/` (`<source>+<name>` for an agent from a source), that is never part of any repository:

- `MEMORY.md` is the agent's long-term memory. It is read at the start of each request, and the agent updates it when it learns something that should hold from then on.
- Any other private file the agent's `CLAUDE.md` refers to goes there too.

There are two ways to fill it:

- **Tell the agent.** Send a request such as "Remember: refund requests are always high urgency" and it updates its `MEMORY.md`.
- **Write the file yourself.** The folder is available over HTTP, with exact content and no Claude call:

  ```bash
  curl -X PUT http://localhost:48271/agents/triage/data/MEMORY.md \
    -H "Authorization: Bearer $API_TOKEN" --data-binary @MEMORY.md
  ```

  | Call | Effect |
  |---|---|
  | `GET /agents/<agent>/data` | List the files, with size and modification time |
  | `GET /agents/<agent>/data/<file>` | Download one, for example to see what the agent has remembered |
  | `PUT /agents/<agent>/data/<file>` | Create or replace one; the request body is the content. Sub-folders are created as needed |
  | `DELETE /agents/<agent>/data/<file>` | Delete one |

  `<agent>` is `name` or `source/name`. Hidden files are not served.

### Secrets: the agent's `.env`

A file named `.env` in the private folder holds `KEY=VALUE` lines that are added to the environment of that agent's process, and of no other. Use it for tokens and settings that the agent's scripts or `.mcp.json` need:

```bash
curl -X PUT http://localhost:48271/agents/my-agent/data/.env \
  -H "Authorization: Bearer $API_TOKEN" --data-binary @.env
```

- It is write-only over the API: it can be replaced or deleted, the listing shows that it exists, and reading it returns `403`.
- Names the server itself depends on (`PATH`, `HOME`, `API_TOKEN`, `CLAUDE_*`, `ANTHROPIC_*`, `AGENT_*`) are ignored.
- Agents from untrusted sources do not get one.

Every agent's process also gets `AGENT_DATA_DIR` (its private folder) and `AGENT_WORKSPACE` (the workspace, whose files `/files` serves), so scripts need no fixed paths.

`data.example/` shows what an agent's folder looks like.

## Tools

`.mcp.json` lists MCP servers; Claude Code connects to them during a request. Values written as `${NAME}` are taken from the server's environment, so secrets stay in `.env` (see `triage/.mcp.json.example`). Two common sources:

- **n8n**: a workflow with an *MCP Server Trigger* and tool nodes attached to it. The trigger's URL goes in `.mcp.json`, and the tools run with n8n's credentials.
- **Any other MCP server**, for applications that do not involve n8n.

List the tools the agent may call in `agent.json`, for example `"allowedTools": "Read,mcp__n8n-toolbox"`.

`allowedTools` only says what runs without asking; other built-in tools still exist in the session and are refused when used. To remove them entirely, for instance for an agent that reads untrusted text, also set `"tools": "Read,Glob,Grep"`.

## Agents from other repositories

Agents do not have to live in this repository. A **source** is a git repository whose agents are added to the local ones and called as `source/name`. The list of sources is stored on the server (in the agent-data volume, so it survives redeploys) and edited through the API:

```bash
curl -X PUT http://localhost:48271/agents/sources \
  -H "Authorization: Bearer $API_TOKEN" -H "content-type: application/json" \
  -d '{"sources": [
        {"name": "mine", "git": "https://github.com/you/your-agents", "ref": "main", "path": "agents", "tokenEnv": "MY_AGENTS_TOKEN", "trusted": true},
        {"name": "community", "git": "https://github.com/someone/agents", "ref": "<full commit sha>"}
      ]}'
```

`PUT` replaces the whole list, fetches every source and returns each one's status. An invalid list is rejected and changes nothing.

| Field | Meaning |
|---|---|
| `name` | Prefix of its agents: `mine/reviewer` |
| `git` | HTTPS clone URL, without credentials |
| `ref` | Branch, tag or commit. A source that is not trusted must give a full 40-character commit |
| `path` | Folder in the repository that holds the agents. Default: the repository root |
| `tokenEnv` | For a private repository: the name of an environment variable on the server that holds a token. The token is never stored in the list |
| `trusted` | `true` for repositories you control. Default `false` |

| Call | Effect |
|---|---|
| `GET /agents/sources` | The list, with each source's commit, last sync time and last error |
| `PUT /agents/sources` | Replace the list and sync |
| `POST /agents/sync` | Fetch again; `{"source": "mine"}` for one. Also happens when the server starts |

A source that fails to sync keeps its previous version and reports the error; other sources and local agents are unaffected.

### What counts as an agent in a source

- a folder with a `CLAUDE.md`, as described above, or
- a single Markdown file that starts with a header containing `name` and `description`, which is Claude Code's subagent format and what public collections usually contain. The text after the header is the instructions; `tools` and `model` in the header work like `agent.json`.

Sub-folders are searched a few levels deep. Files without such a header (a README) are ignored.

### Trusted and untrusted sources

An agent from someone else's repository runs on your server with your Claude subscription, so sources are untrusted unless you say otherwise.

| | Trusted | Untrusted (default) |
|---|---|---|
| Version | Any branch, tag or commit | A pinned commit only, so it cannot change without you |
| What is used from the repository | Everything: instructions, `agent.json`, `.mcp.json`, skills, settings | The instructions only |
| Tools | What the agent declares, or `CLAUDE_ALLOWED_TOOLS` | Only `UNTRUSTED_TOOLS` (default `Read,Glob,Grep,Write,Edit`): no shell, no network, no MCP |
| Files it can reach | The workspace and its private folder | Its private folder, its own output folder `agent-files/<source>+<name>/` in the workspace, and the files uploaded with the request |
| Server environment (tool secrets) | Visible | Not passed on |

Mark a source trusted only if you control it. Before adding a public source, read the agents you intend to use at the commit you pin.

## Adding an agent

1. Create `agents/<name>/CLAUDE.md`. Keep it short; move long procedures into a skill and personal details into the private folder.
2. If callers need a fixed answer shape, add `schemas/<task>.json`.
3. If it needs tools, add `.mcp.json` and name them in `agent.json`.
4. Rebuild and redeploy the API (`docker compose build && docker compose up -d api`). To add agents without rebuilding, put them in another repository and add it as a source, or put the folder in `AGENTS_DIR`.
5. Check that `GET /agents` lists it, then call it.

## Using an agent from a workflow or an application

1. Send `POST /ask` with `agent` and `prompt`. Add `output_schema` to get the answer as an object in `output`.
2. For a dialogue, add `conversation` with a key of your choice (a chat id, a ticket number). The server keeps the Claude session behind that key, so the caller stores nothing.
3. Act on `output` (or `result`) in the caller, or give the agent tools and let it act itself.
