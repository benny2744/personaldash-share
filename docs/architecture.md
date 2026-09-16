# WorkDash — Architecture Overview

## System Design

PersonalDash is a Next.js web application that provides a premium dashboard over a folder of Markdown notes stored on the local filesystem. It uses Postgres as a derived query-optimized index.

### Data Flow

```
Obsidian Vault (Markdown) ──fs.watch──▶ Indexer ──▶ PostgreSQL
                                                        │
                          ◀──write-back──  Sync Worker ◀─┘
                                                        │
                              Next.js API Routes ◀──────┘
                                        │
                              React Frontend ◀──────────┘
```

### Shared libraries

| Module                | Role                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/domain.js`       | Canonical enums and board status definitions (tasks, ideas, meetings) shared by API routes and UI                                                                        |
| `lib/api.js`          | API helpers: `errorResponse`, JSON body parsing, `isAllowed`, date/number parsers; re-exports domain constants                                                          |
| `lib/fetcher.js`      | Shared SWR `fetcher` for client data hooks                                                                                                                              |
| `lib/drawerUtils.js`  | Shared drawer helpers (e.g. frontmatter field builders)                                                                                                                 |
| `lib/taskStats.js`    | Single source of truth for task status bucketing (`normalizeStatus`, `computeTaskStats`) so kanban counts never drift                                                   |

API routes validate against `lib/domain.js` constants; UI drawers import the same labels/values to stay aligned with write-back.

### Key Invariants

1. Markdown is the source of truth — Postgres is a derived projection
2. Only frontmatter fields are synced bidirectionally (task, project, idea, and meeting metadata)
3. Write-back never modifies body content
4. The indexer and sync worker use hash comparison for loop prevention
5. **Prisma `@db.Date` fields serialize as UTC-midnight Date objects** — always use `toDateStr()` or `parseDateLocal()` to extract the local calendar date; never use `toISOString().split('T')[0]` on Prisma Date values

### Date handling pattern

Prisma `@db.Date` fields are stored as pure dates in Postgres but arrive in JS as `Date` objects set to UTC midnight (`2026-05-10T00:00:00.000Z`). Using `.toISOString().split('T')[0]` can produce the wrong date if the server's local timezone is behind UTC (e.g. the Americas).

The established pattern is:

```js
function toDateStr(dateInput) {
  const d = new Date(dateInput);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
```

This reads local calendar components and produces a `YYYY-MM-DD` string unaffected by timezone offsets. Use it anywhere a Prisma Date field needs to be compared or displayed as a date string.

For date arithmetic (advancing days, computing ranges), parse with `new Date(dateStr + 'T12:00:00')` to avoid midnight DST edge cases.

### Task dates in the UI (Kanban “date” filter)

- **`Task.createdAt` / `Note.createdAt` in Postgres** reflect when the row was first inserted (e.g. bulk import), not necessarily when the Obsidian note was authored.
- **`Task.whenDate`** maps from frontmatter **`When`** and is the meaningful schedule/due signal for most tasks.
- The Kanban **date window** filter (last 7 / 30 / 90 days, this year) uses **`whenDate` when present**, and falls back to DB **`createdAt`** only if `When` is missing, so historical work is not hidden solely because everything was indexed in the same minute.
- The date window **defaults to “All”** so the kanban is the source of truth for task totals. Status column counts therefore match the home/dashboard cards, which compute via the shared `lib/taskStats.js` (`computeTaskStats`). A null/empty `Status` is normalized to `archived` everywhere so it never inflates a board column.
- The **“updated” sort** on both kanban boards uses `notes.file_modified_at` (vault file mtime captured by the indexer, exposed as top-level `fileModifiedAt` in the tasks/ideas APIs), not Prisma `updatedAt`. vault notes carry no `Updated:` frontmatter, so mtime is the only edit-time signal; `updatedAt` is a pure DB bookkeeping timestamp that gets reset whenever typed rows are recreated (remounts, reconciles, DB restores).

### Stale-task auto-archiver

`lib/autoArchiver.js` is a daily background worker (registered in `instrumentation.js` alongside the task reminder). It sets tasks to `Archived` when:

- `updatedAt` is older than **30 days**, AND
- `status` ∈ {`Done`, `Proposed`, `Todo`} — **`Doing` is never auto-archived**.

Each archive flows through `enqueueWriteBack` (so frontmatter `Status` is patched) and writes a `taskEvent` audit row. A null/empty status is also treated as a stale candidate. The same logic runs as a one-off via `scripts/archive-stale-tasks.mjs --dry-run`.

## Database Models

| Model         | Table             | Purpose                                                               |
| ------------- | ----------------- | --------------------------------------------------------------------- |
| Note          | `notes`           | Universal index of all Markdown files                                 |
| Task          | `tasks`           | Typed view for `[[task notes]]` notes                                 |
| Project       | `projects`        | Typed view for `[[project notes]]` notes                              |
| Idea          | `ideas`           | Typed view for `[[idea notes]]` notes                                 |
| Meeting       | `meetings`        | Typed view for `[[meeting notes]]` notes under `meetings/`            |
| MeetingJob    | `meeting_jobs`    | Audio-to-note processing jobs (ASR + LLM pipeline)                    |
| TaskEvent     | `task_events`     | Audit log for task field changes                                      |
| SyncState     | `sync_state`      | Per-note sync hash tracking                                           |

## Note Type Detection

Notes are typed via the `base` frontmatter field:

- `base: "[[task notes]]"` → type `task`
- `base: "[[project notes]]"` → type `project`
- `base: "[[idea notes]]"` → type `idea`
- `Type: area`
- `base: "[[meeting notes]]"` → type `meeting`
- `Type: journal`

Additional fallbacks:

- any Markdown note under `meetings/` is inferred as type `meeting` if `base` is missing; legacy `Meetings/` paths are also recognized
- root `Dashboard.md` is inferred as type `dashboard` (indexed for API lookup, not a typed table row)

Meeting title convention:

- meeting `title` is derived from the note filename stem, not first H1 in body

## Wiki-Link Format

Obsidian uses `[[wiki-links]]` for relational references in frontmatter:

- Single: `Project: "[[CL Business]]"` → extract "CL Business"
- Array: `People: ["[[Alice]]", "[[Bob]]"]` → extract ["Alice", "Bob"]
- Write-back must re-wrap: "CL Business" → `"[[CL Business]]"`

## Sync Protocol

### Indexer → DB (Markdown wins)

1. Chokidar detects file change
2. Debounce 500ms
3. Read file, compute SHA-256 hash
4. Skip if hash matches `sync_state.last_written_hash` (our own write)
5. Skip if hash matches `notes.file_hash` (no change)
6. Parse frontmatter, detect type, upsert Note + typed record
7. Update `sync_state.last_seen_hash`

After the initial file scan, a **reconciliation pass** compares live `notes.filepath` rows against the current vault file list. Rows whose files no longer exist (and are not in skip patterns) are soft-deleted and their typed records removed. This prevents stale rows after vault remounts or folder moves — for example, pre-remount `Tasks/...` paths after switching to a whole-brain mount where real files live at `tasks/...`.

### Vault visibility and skip patterns

`VAULT_PATH` points at the **vault root**. Operational content lives under `sources/`, `areas/`, `projects/`, `tasks/`, `ideas/`, `meetings/`, `people/`, `resources/`, `concepts/`; the indexer also reads `concepts/`, `inbox/`, `Archive/`, and `system/` (except skipped subtrees).

Skipped during indexing (and blocked from vault API writes where noted):

| Pattern                                                        | Reason                         |
| -------------------------------------------------------------- | ------------------------------ |
| `.obsidian/`, `.trash/`, `.stversions/`, `.stfolder/`, `.git/` | Tooling / sync metadata        |
| `Secrets/`                                                     | Hard ban per vault AGENTS.md   |
| `Temp/`                                                        | Scratch                        |
| `Templates/`, `system/Templates/`                              | Template stubs, not live notes |
| Hidden files (`/.`)                                            | Dotfiles                       |

API write guardrails additionally reject PUT/PATCH to `sources/**` (immutable), `concepts/concepts/**` (approval-only), and anything under `Secrets/`.

### DB → Markdown (WebApp wins)

1. API PATCH updates DB record
2. Enqueue write-back job (p-queue, concurrency=1)
3. Worker reads file, computes hash
4. If hash ≠ `last_seen_hash` → conflict (abort, mark sync state)
5. If match → re-read file immediately before write; if hash changed → conflict (closes race with external Obsidian saves)
6. Patch frontmatter fields and write via `lib/vault.writeNote`
7. Update `sync_state.last_written_hash` = new hash
8. Indexer sees change, compares hash → skips (our write)

## Kanban Drawer Metadata Editing

- The task drawer in `/kanban` includes a collapsible **Front matter** section (collapsed by default when opening a task).
- Saving from the drawer sends a `PATCH /api/tasks/[id]` payload and updates the SWR task list optimistically in the board.
- Supported editable task metadata fields are:
  - `status` → `Status`
  - `priority` → `Priority Level`
  - `whenDate` → `When`
  - `project` → `Project`
  - `domain` → `Domain`
  - `people` → `People`
  - `courses` → `Courses` (reads legacy `📕 Courses` as a fallback)
- Write-back uses `lib/frontmatter.js` key mapping and the sync worker queue, so Markdown remains canonical while the UI stays responsive.
- If the backing note file is missing during `PATCH`, the API returns **410 Gone**, soft-deletes the note row, and removes the typed task record so stale DB rows do not reappear after SWR revalidation.

## Meeting Frontmatter Sync

- Meetings are extracted from canonical frontmatter keys:
  - `Date`, `Type`, `Attendees`, `Project`, `Area`, `Action Items`, `Decisions`, `Notes`, `tags`
- Supported `Type` values are `Leadership`, `Hiring`, `Admissions`, `Curriculum`, `Program Ops`, `Student Mentoring`, `Partnership`, and `Parent Comms`
- Meeting write-back maps API fields to the same keys:
  - `meetingDate` → `Date`
  - `meetingType` → `Type`
  - `attendees` → `Attendees`
  - `project` → `Project`
  - `area` → `Area`
  - `actionItems` → `Action Items`
  - `decisions` → `Decisions`

## Meeting Audio Pipeline

Upload audio from `/meetings` to produce a canonical Obsidian meeting note. Unlike vault-indexed meetings, the pipeline **creates new Markdown files** rather than syncing existing frontmatter bidirectionally.

```
Web UI ──POST multipart──▶ /api/meetings/process
                              │
                              ├─▶ S3 (temporary audio object)
                              ├─▶ meeting_jobs row (status=queued)
                              └─▶ DB-backed worker claims queued jobs
                                      │
                                      ▼
                              runMeetingJob (one at a time)
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              Qwen ASR          summarize/format      task notes
           (presigned URL)   code OR opencode agent   tasks/*.md
                    │                 │                 │
                    └────────┬────────┴────────┬────────┘
                             ▼                 ▼
                      assemble + write meeting note
                             │
                             ▼
                meetings/YYYY-MM-DD Type Topic.md
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
       Indexer → Meeting + Task rows   linker worker (optional)
                                              │
                                              ▼
                                    EntitySuggestion inbox
```

Consecutive uploads are **not** processed in parallel. A startup worker in `lib/meetingPipeline/job.js` periodically claims the oldest `queued` job from Postgres and runs it to completion before claiming the next one. Queue state and cancellation are durable in `meeting_jobs`, so restarts do not lose pending work.

When `MEETING_FORMATTER=opencode`, the summarize/format stage routes to a **per-type opencode agent** over HTTP (`lib/meetingPipeline/formatAgent.js`). The agent returns a JSON contract that `runPass4Assemble` renders into the note body. On failure or invalid JSON, the pipeline **falls back automatically** to the deterministic code summary passes (`runPass2Zh` / `runPass3En`). Each opencode run creates a persistent, titled session; `MeetingJob.opencodeSessionId` and `opencodeShareUrl` are stored for inspection in the opencode web UI.

After a note is written and indexed, an optional **link-lint worker** (`lib/meetingPipeline/linker.js`) resolves entity mentions against People/Projects/Areas notes (exact matches applied via write-back; fuzzy/unresolved items persisted as `EntitySuggestion` rows for the Link Review inbox on `/meetings`).

### Pipeline steps

| Step         | Action                                                                                                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upload`     | Receive audio, store in S3, create `MeetingJob`                                                                                                                                                                                                                                                 |
| `queued`     | Waiting in the serial worker queue (upload complete, processing not started)                                                                                                                                                                                                                    |
| `transcode`  | Audio files larger than `MEETING_ASR_TRANSCODE_THRESHOLD` are transcoded to low-bitrate mono MP3 with ffmpeg (temp-file download for full format detection); originals are kept until ASR succeeds, then deleted                                                                                 |
| `asr`        | DashScope async transcription via presigned URL                                                                                                                                                                                                                                                 |
| `clean`      | LLM pass 1: metadata extraction + verbatim transcript cleanup (chunked when transcript > 2.5k chars; substeps like `clean_metadata`, `clean_chunk_N_of_M`)                                                                                                                                      |
| `format`     | **opencode only:** per-type format agent returns JSON contract (`summary_en`, `summary_zh`, `action_items`, `decisions`, `frontmatter_extra`); falls back to code passes on failure                                                                                                             |
| `summary_zh` | LLM pass 2: Chinese summary (code path only; skipped when opencode contract provides `summary_zh`)                                                                                                                                                                                              |
| `summary_en` | LLM pass 3: English summary (code path only; skipped when opencode contract provides `summary_en`)                                                                                                                                                                                              |
| `tasks`      | Parse action items from contract or English summary; LLM maps each to title/people/when; write `tasks/*.md` with `Status: Proposed` and wiki-link back to the meeting (`lib/meetingPipeline/tasks.js`)                                                                                          |
| `assemble`   | Pass 4: combine meeting frontmatter + body. **Code path:** fixed layout (Context, Agenda, Decisions, Action Items, Notes, 中文总结). **Opencode path:** type-specific `summary_en` rendered verbatim + deterministic Attendees / 中文总结 / Transcript blocks (`lib/meetingPipeline/passes.js`) |
| `write`      | Write meeting note to `meetings/` with collision-safe filename                                                                                                                                                                                                                                  |
| `done`       | Delete S3 audio object, set `outputPath` on job; enqueue link-lint pass when linker is enabled                                                                                                                                                                                                  |

### Link review inbox

Unresolved or fuzzy entity mentions surfaced by the linker are stored in `entity_suggestions` and shown on `/meetings` via `LinkReviewInbox`:

- `GET /api/link-suggestions?status=pending` — list suggestions with meeting context
- `POST /api/link-suggestions/[id]/action` — `{ action: "create" | "map" | "dismiss", ... }`

Actions can create stub People/Projects/Areas notes, map a mention to an existing note (with optional alias learning via frontmatter `aliases:`), or dismiss. Alias maps from vault notes are loaded into `vaultContext` for better attendee/project/area resolution during assembly and linking.

### API routes

- `POST /api/meetings/process` — upload audio (`audio` form field), returns `202` with job record. Used for submissions under `MEETING_UPLOAD_CHUNK_THRESHOLD`.
- `GET /api/meetings/process?active=1` — list in-flight and recently finished jobs (UI polls every 4s)
- `GET /api/meetings/jobs/[id]` — single job status
- `PATCH /api/meetings/jobs/[id]` — cancel an active job (`{ "status": "cancelled" }`) or requeue a failed/cancelled job whose audio is still in S3 (`{ "status": "queued" }`)

**Autochunking upload routes** (submissions ≥ chunk threshold; each HTTP request stays ≤ `MEETING_AUDIO_CHUNK_SIZE` to fit under the Cloudflare Tunnel ~100 MB ceiling, reassembled via S3 multipart):

- `GET /api/meetings/uploads/config` — client pre-validation (`{ chunkSize, chunkThreshold, maxBytes }`)
- `POST /api/meetings/uploads/init` — idempotent (client `submissionId`); creates one `MeetingJob` + one `MeetingUpload` per file, opens S3 multipart sessions for files > chunk size
- `PUT /api/meetings/uploads/[id]` — raw-binary single PUT for files ≤ chunk size (here `[id]` is a `MeetingUpload` id)
- `PUT /api/meetings/uploads/[id]/parts/[partNumber]` — raw-binary chunk to S3 `UploadPart`; upserted by part number
- `POST /api/meetings/uploads/[id]/complete` — bodyless, terminal-idempotent; `ListParts` is authoritative, completes each multipart session, flips job → `queued` (here `[id]` is a `MeetingJob` id)
- `POST /api/meetings/uploads/[id]/abort` — bodyless, idempotent; aborts every live multipart session

- `GET /api/link-suggestions` — list entity link suggestions for the review inbox
- `POST /api/link-suggestions/[id]/action` — act on a suggestion (create note, map, dismiss)

### Job cancellation and retry

In-progress pipeline jobs can be cancelled via the UI cancel button or `PATCH /api/meetings/jobs/[id]`. The mechanism:

1. `PATCH` calls `cancelMeetingJob(id)` to set `status='cancelled'` in Postgres.
2. The pipeline checks the durable job status before each major step and inside the ASR poll loop.
3. On cancellation, the job is marked `cancelled` with the current step preserved and S3 audio is deleted.

Failed or cancelled jobs can be retried with `PATCH /api/meetings/jobs/[id]` and `{ "status": "queued" }` (`requeueMeetingJob`), provided their audio is still in S3. To keep retry possible after a container restart, the startup orphan-audio GC (`sweepOrphanAudio` in `lib/meetingPipeline/startup.js`) protects audio referenced by jobs that failed or were cancelled within the last 24 hours (`listRecentlyFinishedAudioKeys`), matching the grace window used by the daily orphan sweeper.

### Configuration (`lib/config.js`)

| Env var                                           | Default                                              | Purpose                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `MEETING_AUDIO_MAX_BYTES`                         | `524288000` (500 MB)                                 | Whole-submission upload cap (Σ audio + supplementary)                                                                    |
| `MEETING_AUDIO_CHUNK_SIZE`                        | `52428800` (50 MB)                                   | S3 multipart part size for autochunked uploads                                                                           |
| `MEETING_UPLOAD_CHUNK_THRESHOLD`                  | `94371840` (90 MB)                                   | Submission-total size that triggers the chunked flow                                                                     |
| `MEETING_UPLOAD_TTL_MS`                           | `3600000` (1 h)                                      | Inactivity TTL before an in-flight upload is considered abandoned                                                        |
| `MEETING_ASR_TRANSCODE_THRESHOLD`                 | `52428800` (50 MB)                                   | Audio files larger than this are transcoded to MP3 before ASR (`0` disables)                                             |
| `MEETING_ASR_TRANSCODE_BITRATE`                   | `32`                                                 | Target MP3 bitrate in kbps for ASR transcoding (mono, 16 kHz)                                                            |
| `MEETING_S3_ENDPOINT`                             | `http://minio:9000`                                  | S3-compatible storage endpoint                                                                                           |
| `MEETING_S3_PUBLIC_BASE`                          | —                                                    | Public base URL for presigned ASR access                                                                                 |
| `MEETING_S3_BUCKET`                               | `meeting-audio`                                      | Bucket name                                                                                                              |
| `MEETING_S3_ACCESS_KEY` / `MEETING_S3_SECRET_KEY` | —                                                    | Credentials                                                                                                              |
| `QWEN_ASR_API_KEY`                                | —                                                    | DashScope API key                                                                                                        |
| `QWEN_FILETRANS_MODEL`                            | `qwen3-asr-flash-filetrans`                          | ASR model                                                                                                                |
| `MEETING_LLM_PROVIDER`                            | `zai`                                                | LLM provider for cleanup/summary passes (`zai`, `qwen`, `openai`, `anthropic`, `mimo`)                                   |
| `MEETING_LLM_MODEL`                               | `glm-5` (or `mimo-v2.5-pro` when provider is `mimo`) | Model for LLM passes                                                                                                     |
| `MEETING_LLM_TIMEOUT_SEC`                         | `900`                                                | Per-request LLM fetch timeout (uses `AbortSignal.timeout`)                                                               |
| `MIMO_API_KEY`                                    | —                                                    | Xiaomi MiMo API key (Token Plan or standard endpoint)                                                                    |
| `MIMO_BASE_URL`                                   | `https://token-plan-cn.xiaomimimo.com/v1`            | MiMo OpenAI-compatible base URL                                                                                          |
| `MIMO_MODEL`                                      | `mimo-v2.5-pro`                                      | Default MiMo model when `MEETING_LLM_PROVIDER=mimo` and `MEETING_LLM_MODEL` is unset                                     |
| `ZAI_API_KEY` / `ZAI_BASE_URL` / `ZAI_MODEL`      | —                                                    | Z.ai fallback provider                                                                                                   |
| `MEETING_FORMATTER`                               | `code`                                               | Summarize/format engine: `code` (deterministic LLM passes) or `opencode` (per-type agents over HTTP, with code fallback) |
| `OPENCODE_SERVER_URL`                             | —                                                    | opencode HTTP base URL (container default `http://host.docker.internal:4096` via bridge forwarder)                       |
| `OPENCODE_SERVER_USERNAME`                        | `opencode`                                           | HTTP Basic auth username when password is set                                                                            |
| `OPENCODE_SERVER_PASSWORD`                        | —                                                    | HTTP Basic auth password; omit for passwordless local server                                                             |
| `OPENCODE_FORMATTER_MODEL`                        | `xiaomi-token-plan-cn/mimo-v2.5-pro`                 | Model pinned to the opencode summarize/format agent (`providerID/modelID` format)                                        |
| `OPENCODE_LINKER_MODEL`                           | `xiaomi-token-plan-cn/mimo-v2.5`                     | Model pinned to the opencode linker (name resolution / lint) agent (`providerID/modelID` format)                         |
| `OPENCODE_TIMEOUT_SEC`                            | `900`                                                | Per-call opencode fetch timeout                                                                                          |
| `OPENCODE_AGENT_BY_TYPE`                          | —                                                    | Optional JSON `{ "Meeting Type": "agent-name" }` overrides                                                               |
| `OPENCODE_VAULT_PATH`                             | host vault path                                      | Vault root as seen by the opencode **host** (for linker prompts); differs from in-container `/vault`                     |
| `MEETING_LINKER_ENABLED`                          | `false` (auto-on with opencode formatter)            | Enable link-lint worker independently of `MEETING_FORMATTER`                                                             |

Meeting LLM prompts load SOP/template context from `{VAULT_PATH}/system/` and list People/Projects/Areas (plus `aliases:` from their frontmatter) from `{VAULT_PATH}/`.

Per-type opencode agent definitions live in `lib/meetingPipeline/opencode/agents/` and are copied to `~/.config/opencode/agent/` on the host. Ops setup (bridge forwarder, UFW rule, rollout) is documented in `deploy-opencode-meeting-pipeline.md`.

**MiMo provider notes:** MiMo uses the `api-key` HTTP header (not `Authorization: Bearer`) and sends `max_completion_tokens` instead of `max_tokens`. MiMo is a reasoning model; clean-pass adaptive retry already handles reasoning-only responses.

### Audio filename dates

When the upload filename contains a date, `dateFromFilename()` in `lib/meetingPipeline/passes.js` tries both YMD and MDY patterns with a **consistent separator** (`-`, `_`, or `.` — not space). It picks the leftmost valid calendar date and rejects dates more than one day in the future. This prevents iOS Voice Memo names like `06-18-2026 11.03.mp3` from being parsed as `2026-11-03` via the trailing timestamp.

### Long-transcript handling

When ASR output exceeds single-call limits, passes split work automatically:

| Threshold                  | Behavior                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| > 2,500 chars (clean)      | Metadata extracted from a 1.5k-char head/tail preview; transcript cleaned in ~2.5k-char chunks, then concatenated |
| > 10,000 chars (summaries) | Partial summaries per chunk, then a final synthesis pass for the full zh/en summary                               |

**Adaptive clean retries:** if a clean chunk fails with reasoning-only output, an LLM header timeout, or a transient overload/rate-limit error (`HTTP 429` / `5xx`), the chunk is halved and retried recursively. Fragments below 600 chars that still fail use the raw ASR text so the job can continue.

**LLM call retries:** `lib/meetingPipeline/llm.js` retries up to 4 times on transport blips (`EAI_AGAIN`, timeouts, etc.) and on HTTP 429/5xx, with exponential backoff and `Retry-After` honored when present.

Failed jobs store errors as `{step}: {message}` (e.g. `clean_chunk_1_of_4: chunk 1/4: ...`) so the UI can show which stage broke.

Upload progress uses XHR `upload.onprogress` in `MeetingUploader` (percent, bytes, speed, ETA, finalizing state).

### Startup recovery

On boot (`instrumentation.js`), `recoverMeetingJobs()` marks stale queued jobs as failed and deletes orphan S3 audio objects whose jobs are no longer active.

## Progressive Web App (PWA)

PersonalDash is a PWA with offline support and push notifications.

### Service Worker (`sw/service-worker.js`)

- **Serwist v9** integration via `@serwist/next` (uses `--webpack` to avoid Turbopack conflict in Next.js 16)
- Caching strategies:
  - Pages: `StaleWhileRevalidate` (30-day cache)
  - API routes (`/api/*`): `NetworkFirst` with 10s timeout (30-day cache)
  - Images: `CacheFirst` (7-day cache)
  - Static assets: inherited from `@serwist/next` default cache
- Service worker only activates in production builds

### Web App Manifest (`app/manifest.js`)

- Served at `/manifest.webmanifest` via Next.js App Router
- Display mode: standalone
- Icons: 192x192, 512x512, maskable 512x512 (generated by `scripts/generate-icons.js`)

### Offline Mode

- `hooks/useNetworkStatus.js` — tracks online/offline state
- `components/layout/OfflineBanner.js` — shows offline indicator
- All pages cache for offline viewing (read-only)
- Editing is disabled when offline

### Push Notifications

- **VAPID keys** stored in `.env` / `.env.local`
- `PushSubscription` model in Prisma (`push_subscriptions` table)
- API routes:
  - `POST /api/push/subscribe` — save subscription
  - `POST /api/push/unsubscribe` — remove subscription
  - `POST /api/push/send` — send to all subscribers
- `lib/taskReminder.js` — hourly worker sends push for upcoming tasks
- `components/layout/PushPermissionPrompt.js` — requests permission on first load

### Deployment

- `Dockerfile` copies `prisma/` and `prisma.config.ts` into runner stage
- `docker-entrypoint.sh` runs `prisma migrate deploy` before starting server
- CORS headers configured in `next.config.mjs` for manifest, sw.js, and icons

## Kanban Board Statuses

Active board columns: **Proposed**, **Todo**, **Doing**, **Done**. `Waiting` and `Blocked` are retired from the UI.

- **Proposed** cards show inline accept (→ Todo) and a visible **Archive** quick action (→ `Archived`).
- **Done** column header includes **Archive All** to bulk-set visible Done tasks to `Archived`.
- Status changes flow through `PATCH /api/tasks/[id]` and the standard write-back sync worker.
