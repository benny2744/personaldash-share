# WorkDash

A self-hosted workspace dashboard over a folder of Markdown notes:

- **Chat** — talk to a [Hermes](https://github.com/hermes) agent gateway (sessions,
  work traces, voice input/output).
- **DingTalk chat** — read and send DingTalk messages in the same chat UI
  (via the [`dws` CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-tool)).
- **Calendar** — month/week views merging vault-dated tasks/meetings with a
  read-only CalDAV feed (DingTalk Calendar or any CalDAV server).
- **Kanban** — drag-and-drop task + idea boards over Markdown notes.
- **Projects** — project boards plus an LLM "project chat" that edits the
  backing note.
- **Meetings** — meeting-note timeline, plus an optional audio → structured
  note pipeline (ASR + LLM + formatter agents).

Markdown files are the source of truth; Postgres is a rebuildable derived
index. Web edits write frontmatter back to the files.

> **Security:** there is no authentication. Run it behind a reverse proxy
> with TLS on a private network (or add auth at the proxy).

## Quick start (Docker)

Prerequisites: Docker with the compose plugin, a Markdown vault folder, and
(for DingTalk/Hermes features) the host-side tools below.

```sh
cp .env.example .env   # fill in the values
docker compose up -d --build
```

The app serves on `http://127.0.0.1:3003`. Migrations run automatically at
container start (`prisma migrate deploy` via `docker-entrypoint.sh`).

Compose starts four services — `app`, `pipecat-voice` (chat voice),
`libreoffice-converter` (document text extraction), and a convenience
`db` (Postgres 16). Point `DATABASE_URL` at your own Postgres instead if
you prefer.

## Host-side prerequisites

### DingTalk (`dws`)

Install and authenticate the dws CLI on the **host** as the user the app
container maps to:

```sh
# https://github.com/DingTalk-Real-AI/dingtalk-workspace-tool
dws auth login
```

Then set the compose env vars `VAULT_HOST_PATH`, `DWS_HOST_PATH`,
`DWS_CONFIG_HOST_PATH`, `DWS_DATA_HOST_PATH` in `.env` (see
`.env.example` for the layout). Sending messages and downloading media
shell out to `dws` from the container.

**Message sync** (optional): run the collector as a systemd user service to
poll new DingTalk messages into Postgres (needed for the DingTalk sidebar to
show conversations):

```sh
cp deploy/systemd/dingtalk-bridge.service.example ~/.config/systemd/user/dingtalk-bridge.service
# edit WorkingDirectory/Environment to your checkout + DATABASE_URL
systemctl --user daemon-reload && systemctl --user enable --now dingtalk-bridge
```

A nightly backfill (90 days of history) is available as
`deploy/systemd/dingtalk-backfill.{service,timer}.example`. More:
[`services/dingtalk-bridge/`](services/dingtalk-bridge/).

### Hermes

Point `HERMES_DASHBOARD_URL` + `HERMES_DASHBOARD_SESSION_TOKEN` in `.env` at
your Hermes dashboard gateway. If you expose the Hermes SPA same-origin under
a path prefix, set `HERMES_BASE_PATH` (default `/hermes`) and proxy that path
to the gateway. The chat page talks to the gateway over WebSocket
(JSON-RPC) plus a REST bootstrap.

### Meetings audio pipeline (optional)

Audio uploads need S3-compatible storage (`MEETING_S3_*`), a transcription
provider (`QWEN_FILETRANS_*` / `QWEN_ASR_API_KEY`), and a meeting LLM
(`MEETING_LLM_*`, OpenAI-compatible). The format stage defaults to
deterministic in-code passes; set `MEETING_FORMATTER=opencode` to use
[opencode](https://opencode.ai) formatter agents instead — copy
[`lib/meetingPipeline/opencode/agents/`](lib/meetingPipeline/opencode/) onto
the opencode host and see its README.

### Chat voice (optional)

Voice input/output uses the `pipecat-voice` sidecar with Qwen realtime
ASR/TTS (`DASHSCOPE_API_KEY`, `VOICE_LEASE_SECRET`).

### External vault indexer (optional)

If you run a gbrain-style indexer over the same vault, set
`GBRAIN_SYNC_HOOK_URL` and every dashboard write-back will trigger a re-sync.
No-op when unset.

## Development

```sh
pnpm install
pnpm dev        # http://localhost:3000
pnpm test
pnpm lint
```

Node 22+, pnpm 10. Set the env vars from `.env.example` first (at minimum
`DATABASE_URL`, `VAULT_PATH`, `MEETING_S3_ENDPOINT`, `MEETING_S3_PUBLIC_BASE`,
`QWEN_FILETRANS_BASE_URL`).

## Layout

| Path | Purpose |
| ---- | ------- |
| `app/` | Next.js App Router pages + API route handlers |
| `components/` | React UI (shell, kanban, meetings, hermes, dingtalk, calendar) |
| `lib/` | indexer, sync worker (frontmatter write-back), caldav, hermes client, meeting pipeline, cache layer |
| `services/dingtalk-bridge/` | message collector/backfill CLI scripts (raw SQL) |
| `services/pipecat-voice/` | Qwen realtime ASR/TTS sidecar |
| `services/libreoffice-converter/` | document text extraction sidecar |
| `prisma/` | schema + migrations (including the hand-written DingTalk chat tables) |
| `docs/architecture.md` | indexer/sync/pipeline design notes |

## Note

Meeting types, app name, and model tiers are user-specific and configurable:
see `MEETING_TYPES`, `APP_NAME`, and the `LLM_TIER_*` env vars.
