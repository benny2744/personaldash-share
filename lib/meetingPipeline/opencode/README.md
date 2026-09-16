# opencode meeting agents

Starter opencode agent definitions for the meeting-notes pipeline. These are
**not loaded by the app** — copy them onto the opencode **host** so the running
`opencode serve` instance (127.0.0.1:4096) can serve them to the pipeline over
HTTP.

## Install

Copy the `.md` files into the opencode global agents directories — **both** the
singular and plural forms, because installed opencode versions read both and a
stale copy in one silently shadows updates in the other:

```sh
mkdir -p ~/.config/opencode/agent ~/.config/opencode/agents
cp lib/meetingPipeline/opencode/agents/*.md ~/.config/opencode/agent/
cp lib/meetingPipeline/opencode/agents/*.md ~/.config/opencode/agents/
```

The document parser assumes a separate `libreoffice-converter` service is
running on the opencode host at `http://localhost:8083`. See
`services/libreoffice-converter/` for the service definition and
`docker-compose.yml` for deployment.

Then restart opencode (config is loaded once at startup):

```sh
systemctl --user restart opencode.service
# or, when running manually:
opencode web --hostname 127.0.0.1 --port 4096
```

Verify the served contract after agent changes (config is only read at startup):

```sh
SID=$(curl -s -X POST 'http://127.0.0.1:4096/session?directory=/tmp' \
  -H 'Content-Type: application/json' -d '{"title":"probe"}' | jq -r .id)
curl -s -X POST "http://127.0.0.1:4096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"agent":"meeting-curriculum","parts":[{"type":"text","text":"List the top-level JSON keys of your output contract, comma-separated."}]}'
```

If you set `OPENCODE_SERVER_PASSWORD`, pass it when starting the server; the
pipeline client sends HTTP Basic auth using `OPENCODE_SERVER_USERNAME` (default
`opencode`).

## What each agent does

- `meeting-default` — the generic meeting formatter used for ALL meeting types
  unless overridden. It returns the `meeting_analysis_v1` JSON contract
  (`schema_version`, `summary_en`, `meeting`, `entities`, `decisions`,
  `action_items`, `entity_updates`, `frontmatter_extra`) — the semantic source
  of truth persisted as `meeting_jobs.analysis_json`. The Chinese summary is
  NOT produced by the agent; the pipeline translates `summary_en` on the light
  model tier. Pure text-in/JSON-out: `edit`, `bash`, and `webfetch` are denied.
- `meeting-linker` — read-only fuzzy entity resolver + link linter
  (`edit`/`bash`/`webfetch` denied; `read`/`glob`/`grep` + `/find` only). Returns
  the linker JSON contract; code applies exact matches via the write-back path.
- `meeting-document-parser` — extracts raw text from supplementary meeting
  documents (resumes, PDFs, Word/Excel/PowerPoint, markdown, HTML, etc.). Uses
  the attached file directly when possible; for office/PDF files it can call the
  separate LibreOffice converter service at `http://localhost:8083/convert`.

## Editing formats

These files ARE the source of each note's format. Tweak a section, rename a
heading, or adjust the JSON rules here, restart opencode, and the next meeting
uses the new format — no code change or Docker rebuild.

## Agent-name resolution

`lib/meetingPipeline/formatAgent.js` resolves the agent for every meeting type
to the generic `meeting-default`, unless you provide a custom mapping via the
`OPENCODE_AGENT_BY_TYPE` env var (JSON object of
`{ "Meeting Type": "agent-name" }`). Define your own per-type agents (copy
`meeting-default.md`, tailor the `##` sections, install on the opencode host)
and map them by meeting-type name — e.g.
`OPENCODE_AGENT_BY_TYPE='{"Client":"meeting-client"}'`. The linker agent is
always `meeting-linker`; the document parser is always `meeting-document-parser`.
