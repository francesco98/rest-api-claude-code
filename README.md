# Claude Code in Docker, with an HTTP API

This folder builds one Docker image that runs Claude Code in two ways:

- **`claude`**: the normal interactive terminal UI.
- **`api`**: a small HTTP server ([server.mjs](server.mjs)) that runs `claude -p` for each request, so scripts can send prompts and documents over HTTP. A request can name an [agent](agents/): a folder of instructions, tools and answer schemas kept in this repository.

Both use a Claude Pro/Max subscription through a token from `claude setup-token`.

## Setup

1. Start Docker Desktop.
2. On a machine with a browser and Claude Code installed, run `claude setup-token` and copy the token.
3. Create your `.env`:
   ```bash
   cp .env.example .env
   ```
4. Fill in `.env`:

   | Variable | Required | Meaning |
   |---|---|---|
   | `CLAUDE_CODE_OAUTH_TOKEN` | yes | The token from step 2 |
   | `API_TOKEN` | for the API | Password callers must send. Generate with `openssl rand -hex 32` |
   | `PROJECT_DIR` | no | Host folder Claude works in, mounted as `/workspace`. If unset, a Docker volume is used. On Linux the folder must be writable by uid 1000 |
   | `API_PORT` | no | Port on your machine. Default `48271` |
   | `CLAUDE_ALLOWED_TOOLS` | no | Tools Claude may use through the API. Default `Read,Edit,Write,Glob,Grep,Bash` |
   | `AGENTS_DIR` | no | Host folder with extra agents, added to the ones in [agents/](agents/). See [Agents](#agents) |
   | `MAX_CONCURRENT_JOBS` | no | How many [asynchronous jobs](#asynchronous-jobs) run at once; the rest wait in a queue. Default `2` |
   | `JOB_TIMEOUT_SECONDS` | no | How long one job may run. Default `3600` |
   | `JOB_RETENTION_HOURS` | no | How long a finished job and its result are kept. Default `24` |
   | `WORKSPACE_RETENTION_HOURS` | no | Workspace files not modified for this many hours are deleted; `0` keeps them forever. Default `24` with the Docker volume, `0` when `PROJECT_DIR` is set |

5. Build the image:
   ```bash
   docker compose build
   ```

## Interactive use

```bash
docker compose run --rm claude
```

Use `run`, not `up`: `up` does not attach your terminal to the interactive UI.

## API use

Start and stop the server:

```bash
docker compose up -d api      # start
docker compose logs -f api    # watch logs
docker compose down           # stop
```

The server listens on `http://localhost:48271` and is reachable only from your own machine. The examples below assume the token is in your shell:

```bash
export API_TOKEN=<the value from .env>
```

### Send a prompt

```bash
curl http://localhost:48271/ask \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt": "Summarise README.md in three bullet points"}'
```

Response:

```json
{
  "result": "…Claude's answer…",
  "output": null,
  "is_error": false,
  "session_id": "0b6f…",
  "agent": null,
  "conversation": null,
  "upload_id": null,
  "files": []
}
```

`output`, `agent` and `conversation` are filled when the request uses the fields described under [Agents](#agents).

Claude works in `/workspace`, so prompts can refer to any file in `PROJECT_DIR` by its relative path.

### Continue a conversation

Send back the `session_id` from a previous response:

```bash
curl http://localhost:48271/ask \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt": "Now make it shorter", "session_id": "0b6f…"}'
```

Or let the server remember the session: send a `conversation` key of your choice with every request of the dialogue, instead of `session_id`.

```bash
curl http://localhost:48271/ask \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt": "Now make it shorter", "conversation": "ticket-4812"}'
```

- The first request with a key starts a conversation; later ones continue it.
- A request for a key that is still being answered gets `409`.
- If Claude's stored history for the key is gone, the conversation starts again and the response has `"conversation_restarted": true`.
- `DELETE /conversations/_/<key>` forgets a key (`_` stands for "no agent"; otherwise use the agent's name).

### Upload a document

Send the request as a form, with the prompt in a `prompt` field and one or more files in any other field:

```bash
curl http://localhost:48271/ask \
  -H "Authorization: Bearer $API_TOKEN" \
  -F prompt="Improve the clarity and fix the grammar" \
  -F file=@proposal.md
```

Response:

```json
{
  "result": "I tightened the introduction and …",
  "is_error": false,
  "session_id": "5c1e…",
  "upload_id": "695cab8e-29e6-416a-b400-43526d1b8c2b",
  "files": [
    {
      "name": "uploads/695cab8e-29e6-416a-b400-43526d1b8c2b/proposal.md",
      "url": "/files/uploads/695cab8e-29e6-416a-b400-43526d1b8c2b/proposal.md"
    }
  ]
}
```

What happens to the files:

- Each upload request gets its own folder, `uploads/<upload_id>/`, inside `PROJECT_DIR`. (`job_id` in the response is the former name of `upload_id` and carries the same value.)
- Claude edits the uploaded files in place and puts any new files in the same folder.
- `files` lists every workspace file that was uploaded, created or edited during the request, each with a download `url`. This also applies to plain prompts: if Claude creates `hello.py`, it is listed.
- Hidden files and `node_modules` are left out, and the list is capped at 200 entries.
- Your original is overwritten in that folder, so keep your own copy.

### Download a file

Append a `url` from the `files` list to the server address:

```bash
curl -O http://localhost:48271/files/uploads/<upload_id>/proposal.md \
  -H "Authorization: Bearer $API_TOKEN"
```

Any file in the workspace can be downloaded this way by its relative path, for example `/files/hello.py`, except hidden files such as `.env` or anything under `.git`.

If `PROJECT_DIR` is a host folder, the same files are also there on disk.

### Asynchronous jobs

`/ask` holds the connection open until Claude has finished, and stops a run after 10 minutes. For longer work, or when the caller should not wait, submit the same request as a job. The answer comes back at once with an id:

```bash
curl http://localhost:48271/jobs \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt": "Review every file in the workspace and write REVIEW.md", "callback_url": "https://example.com/hooks/claude"}'
```

```json
{ "id": "1ad8e1f1-8769-4e91-b0ee-e725c8abfef9", "status": "running", "status_url": "/jobs/1ad8e1f1-8769-4e91-b0ee-e725c8abfef9" }
```

A job accepts everything `/ask` does: a JSON body or a form with files, and the same `agent`, `conversation`, `session_id` and `output_schema` fields. Only the two `callback_` fields are extra. A request that `/ask` would refuse (missing prompt, unknown agent, conversation still busy) is refused here too, and no job is created.

For example, an agent run on an uploaded file, with a schema and a webhook. In a form, `callback_headers` is written as JSON text:

```bash
curl http://localhost:48271/jobs \
  -H "Authorization: Bearer $API_TOKEN" \
  -F agent=triage \
  -F output_schema=ticket \
  -F prompt="Classify the attached message." \
  -F callback_url=https://example.com/hooks/claude \
  -F 'callback_headers={"X-Token":"abc"}' \
  -F file=@mail.txt
```

There are two ways to get the result:

- **Poll** `GET /jobs/<id>` until `status` is final. `response` then holds exactly what `/ask` would have returned:

  ```json
  {
    "id": "1ad8e1f1-…",
    "status": "succeeded",
    "created_at": "2026-01-10T09:00:00.000Z",
    "started_at": "2026-01-10T09:00:00.100Z",
    "finished_at": "2026-01-10T09:14:31.512Z",
    "agent": null,
    "conversation": null,
    "response": { "result": "…", "output": null, "is_error": false, "session_id": "…", "files": [] }
  }
  ```

- **Webhook.** With `callback_url`, the server sends that same object to the URL as a `POST` when the job ends. `callback_headers` (an object) adds headers, for example the receiver's own token; they are never shown when the job is read back. Delivery is tried three times; the job's `callback` field records whether it arrived, and a failed delivery leaves the result available by polling. A workflow tool that can pause until it is called back, such as n8n's Wait node, can pass its resume URL here.

| Status | Meaning |
|---|---|
| `queued` | Waiting for a free slot (`MAX_CONCURRENT_JOBS`) |
| `running` | Claude is working |
| `succeeded` | Finished; see `response` |
| `failed` | See `error`: `{status, message}`, with the status code `/ask` would have returned (`504` for a timeout, `503` when the server restarted mid-run) |
| `cancelled` | Stopped by `DELETE /jobs/<id>` |

Other calls:

- `GET /jobs` lists recent jobs without their responses; `?status=running` filters.
- `DELETE /jobs/<id>` cancels a queued or running job, stopping Claude, or removes a finished one.

Jobs and their results are stored on the server and survive a restart, for `JOB_RETENTION_HOURS`. A job that was still queued or running when the server stopped cannot be resumed and is marked `failed`.

### Agents

An agent is a folder under [agents/](agents/) with a `CLAUDE.md` (its instructions) and, optionally, answer schemas, tools and skills. Name one in a request and Claude Code runs inside that folder:

```bash
curl http://localhost:48271/ask \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"agent": "triage", "output_schema": "ticket", "prompt": "I was charged twice, please refund me"}'
```

```json
{
  "result": "{\"category\":\"billing\",\"urgency\":\"high\",…}",
  "output": {
    "category": "billing",
    "urgency": "high",
    "summary": "The sender was charged twice and wants the second payment refunded.",
    "reason": "Duplicate charge is a billing matter; the sender is out of money."
  },
  "is_error": false,
  "session_id": "7f3a…",
  "agent": "triage",
  "conversation": null,
  "upload_id": null,
  "files": []
}
```

Three optional request fields, in JSON or as form fields:

| Field | Meaning |
|---|---|
| `agent` | Folder name of the agent to run. `GET /agents` lists them |
| `output_schema` | A JSON Schema, or the name of a file in the agent's `schemas/`. The answer is validated against it and returned as an object in `output`. Works without `agent` when you send the schema itself |
| `conversation` | A key for a dialogue, as described above. Keys are separate per agent |

Each agent also has a private folder on the server for its memory and personal settings, which is not part of this repository. The agent fills it as it learns, and you can read and write its files with `/agents/<agent>/data`. `triage` is a working example.

Agents can also come from other git repositories, your own or public collections: register them with `PUT /agents/sources` and call them as `source/name`. Agents from a source you have not marked as trusted are pinned to a commit and run with a restricted tool set and no access to the rest of the workspace.

[agents/README.md](agents/README.md) explains the folder layout, memory, tools, sources and trust, and how to add an agent.

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/ask` | yes | Run a prompt. JSON body, or a form with files |
| `POST` | `/jobs` | yes | Run a prompt as an asynchronous job. Same body as `/ask`, plus `callback_url` and `callback_headers` |
| `GET` | `/jobs`, `/jobs/<id>` | yes | List recent jobs, or read one with its result |
| `DELETE` | `/jobs/<id>` | yes | Cancel a queued or running job, or remove a finished one |
| `GET` | `/files/<path>` | yes | Download a workspace file by its relative path |
| `GET` | `/agents` | yes | List agents with their description, source and schema names |
| `GET` `PUT` `DELETE` | `/agents/<agent>/data[/<file>]` | yes | List, read, write or delete the files in an agent's private folder. Its `.env` (the agent's secrets) can be written and deleted, not read |
| `GET` | `/agents/sources` | yes | The git repositories agents are pulled from, with their sync status |
| `PUT` | `/agents/sources` | yes | Replace that list and fetch every source |
| `POST` | `/agents/sync` | yes | Fetch the sources again; `{"source": "name"}` for one |
| `DELETE` | `/conversations/<agent>/<key>` | yes | Forget a conversation key. `<agent>` is `name`, `source/name`, or `_` for conversations without an agent |
| `GET` | `/health` | no | Returns `{"ok": true}` when the server is up |

### Errors

Errors come back as `{"error": "…"}` with one of these status codes:

| Status | Meaning |
|---|---|
| 400 | Missing `prompt`, malformed body, invalid file path, an invalid `agent`, `conversation` or `output_schema`, or an invalid sources list |
| 401 | Missing or wrong `Authorization` header |
| 403 | Reading an agent's `.env` |
| 404 | Unknown path, file not found, or unknown agent, schema, conversation, source or job |
| 409 | The `conversation` is still answering an earlier request, or has a job waiting |
| 413 | Request larger than the upload limit |
| 502 | Claude Code exited without a usable answer; the message includes its output |
| 504 | Claude Code did not finish within the time limit |

A `200` response can still have `"is_error": true` when Claude Code itself reports a failure, such as hitting a usage limit.

## Limits

- **File types.** Text, Markdown, code, images, PDF, Word, Excel and PowerPoint files work. The image ships `pandoc`, LibreOffice, PDF and OCR tools, and Python libraries for office files, and Claude is told they are there.
- **PDF edits.** A PDF has no editable source, so an "improved" PDF is a newly generated one: the text is revised but the original layout, fonts and logos are not preserved. Upload the Word file instead when you have it.
- **Tools.** Through the API, Claude can read, search and edit files and run shell commands inside the container, which it needs for conversions. Every API caller therefore has shell access there. Remove `Bash` from `CLAUDE_ALLOWED_TOOLS` to forbid it; document conversion then stops working.
- **Size and time.** Requests are capped at 25 MB (`MAX_UPLOAD_MB`). A blocking `/ask` call is stopped after 10 minutes (`CLAUDE_TIMEOUT_SECONDS`); an asynchronous job after one hour (`JOB_TIMEOUT_SECONDS`).
- **Cleanup.** Every file in the workspace, uploaded or created by Claude, is deleted once it has not been modified for `WORKSPACE_RETENTION_HOURS` (24 by default). When `PROJECT_DIR` points at a host folder, cleanup is off unless you set the variable yourself, so a real project is never cleaned by accident. Download results before then; after that, links stop working and follow-up prompts can no longer see the file. The server checks at startup and every 15 minutes.
- **Speed.** Every request starts a new Claude Code process, which adds a second or two.
- **Concurrency.** Jobs are limited to `MAX_CONCURRENT_JOBS` at a time. Blocking `/ask` calls are not limited or queued: each starts its own Claude run immediately.

## Subscription and security

- **Personal use only.** Anthropic allows subscription tokens only inside Claude Code and claude.ai. This server stays within that by running the real Claude Code CLI, but it is meant for your own scripts on your own machine, not as a service for other people or apps. For that, use an API key with pay-per-use billing.
- **Usage counts.** Requests draw on your subscription allowance. A script that loops can use it up for hours, so check your usage page after the first few calls.
- **Keep it local.** The port is bound to `127.0.0.1`. Do not expose it to a network: anyone with the `API_TOKEN` can make Claude read and change files in `PROJECT_DIR`.
- **Protect `.env`.** It holds a long-lived subscription token and the API password. Never commit it.

## Maintenance

```bash
docker compose build --pull --no-cache   # update Claude Code and the base image
docker compose down -v                   # also delete saved Claude settings and history
```

## Releases

Pushing a version tag publishes the Docker image to GitHub's container registry ([.github/workflows/release.yml](.github/workflows/release.yml)):

```bash
git tag v1.2.3
git push origin v1.2.3
```

The image is pushed under two tags: the version (`v1.2.3`), which is never overwritten, so earlier releases stay available, and `latest`, which moves to the newest release.

```bash
docker pull ghcr.io/francesco98/rest-api-claude-code:v1.2.3
```

To run a released image instead of building, set `image:` of the `api` service in [docker-compose.yml](docker-compose.yml) to that name and remove its `build:` line.

Each image contains the Claude Code version that was current when it was built.

## Licence

[MIT](LICENSE).
