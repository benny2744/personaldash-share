# Leave-notice forwarder

Standalone Python 3 stdlib implementation. It does not interact with WorkDash
Postgres, the existing collector, or existing configuration. Import and `--check`
are offline. Deployed on the host as the user unit `leave-forwarder.service`
(example: `leave-forwarder.service.example`; installed copy lives in
`~/.config/systemd/user/`) with private config at
`~/.config/leave-forwarder/config.json` (0600, never committed).

## Deployment (2026-10-14)

- Config assembled from verified estate data: profile
  `dingd9aea46ee1dbe683:16284790243402269`, self openId from
  `analysis/dingtalk-bootstrap/dt-inventory.json`, the single visible leave
  template `请假Leave PROC-EF6YCS6WO2-EP923QTSNQ5WP9XASE6V1-UQWEFLCI-E9`
  (`oa approval list-forms`), 6 direct reports (resolved via
  `dws aisearch person` + cross-checked openIds) and all 23 students from
  `analysis/dingtalk-bootstrap/students.json` — 29 applicants.
- Unit contract per below: `Restart=no`, `TimeoutStopSec=30s`, PATH includes
  `~/.local/bin` for `dws`.
- Unknown non-pinned process codes print
  `leave_forwarder: not_leave process_code=<code>` to the journal (constant
  template ids are not PII) — this is how a student-side leave template, if
  one exists, will reveal itself for pinning.
- First real approval event will also confirm the flattened OA field names;
  check `--status` (and the journal) after the first one arrives.

## Configuration contract

Parent/deployer supplies an external JSON file containing:

- `profile`: explicit school DWS profile; applied to every command.
- `self_open_id`: resolved current user's school open DingTalk ID.
- `state_path`: absolute SQLite file path in a **dedicated 0700 directory**.
  The daemon creates a missing directory, refuses a non-private existing one,
  and uses a 0600 database plus a process lock. Do not use a shared directory.
- `leave_process_codes`: nonempty array of verified leave template codes.
- `applicants`: nonempty array of `{user_id, open_id, name, kind}`; `kind` is
  `direct_report` or `student`. Both resolved IDs are required and unique.
  Populate the intended direct reports and all 23 students; the code does not
  guess missing people, enforce an arbitrary staff count, or match names.
- Optional `dws_path`; fallback is `DWS_PATH`, then `dws` from PATH.

The verified staff template code supplied by the parent is
`PROC-EF6YCS6WO2-EP923QTSNQ5WP9XASE6V1-UQWEFLCI-E9`.
It is not implicitly enabled: the real config must explicitly pin it.
Keep config and state private. State contains only minimized outgoing notices,
instance/message IDs, UUID idempotency keys, and constant error codes, never raw
approval detail/event JSON. Keep a state file bound to one profile/recipient and
applicant registry; do not repurpose it across organizations.

## Commands

```sh
python3 -B leave_forwarder.py --config /absolute/path/config.json --check
python3 -B leave_forwarder.py --config /absolute/path/config.json --status
python3 -B leave_forwarder.py --config /absolute/path/config.json --preview-instance REAL_ID
python3 -B leave_forwarder.py --config /absolute/path/config.json
```

`--check` validates JSON/IDs, not auth, actual identity resolution, permissions,
or CLI schemas. `--status` opens existing state read-only and prints counts only;
a missing file reports zero and is not created. `--preview-instance` is an
explicit read-only detail fetch (no subscription, state write, or send). It
requires a pinned `result.processCode` to render; output contains the minimized
notice, so run only in a private terminal. Normal daemon processing fetches
approval detail **only after** an incoming event's process code is pinned.

The daemon makes exactly one `event consume` invocation for task-created and CC,
waits for the stderr ready marker, and handles future flattened NDJSON events.
There is no OA polling, historical listing, automatic subscription retry, or
backfill. Configure any eventual systemd unit with **Restart=no** and sufficient
graceful stop time; do not add an automatic restart loop around it. SIGTERM and
SIGINT stop the loop and terminate/wait for the DWS child, permitting its normal
unsubscribe cleanup. No SIGKILL fallback is used; cleanup timeout is an error.
Raw stdout events, CLI stderr, and sensitive exception messages are never logged.

## Matching and privacy

Detail adapter accepts the parent-verified real shape:
`success=true`, `result.originatorUserid`, `result.formValueVOS`, and optional
`result.processCode` / `result.processInstanceId` consistency checks. It also
accepts the originally proposed `originatorUserId` / `formComponentValues` shape.
Unexpected structure or conflicting identity fails closed.

Only the exact configured **originator user ID** is matched. A parent's request
is NOT attributed to a student via names, form-member values, or family mapping.
That requires a separately verified explicit student-member schema/policy.

Notices have a fixed `请假申请` title (actual processInstanceTitle is unreliable
and raw titles could expose medical details), configured applicant name/kind,
allowlisted leave type, strictly date-shaped strings from exact date-field
names, and instance ID. Reasons, extValue, attachments, nested details and URLs
are omitted. In particular, `请假事由 Reason` is never forwarded.

The staff `DDHolidayField` schema was verified through a real read-only OA detail:
name is the JSON string `["开始时间","结束时间"]`, value is a JSON array.
Only its first two strictly date-shaped strings (including 上午/下午) are copied;
leave type and all remaining array values / extValue are omitted. Unknown or
malformed shapes are not forwarded.

## Delivery safety and schema verification

Each instance has one persistent record, deduplicating task-created/CC and process
restarts. A minimized notice is persisted as `pending` before sending. Immediately
before the external write it is committed as `uncertain`: crash, timeout, missing
send ID, nonzero exit, or failed readback **never causes a blind resend**.

Send uses user identity, explicit self destination, `--yes`, and a stable UUID5
idempotency key derived from profile + self ID + instance ID. Known returned IDs
are persisted before exact `+messages-mget` readback. `sent` requires exact message
ID, exact notice text, and explicit matching recipient.

**Send and readback schemas verified against live DWS output 2026-10-14.**
Send is a two-step flow: `+messages-send` returns only an async
`openTaskId` (in `sendReceipt` / `result.result`; the output uses `ok`, not
`success`); the real `openMessageId` comes from
`+messages-query-send-status --open-task-id` once `sendStatus` is `SUCCESS`
(`result.openMessageId`, mirrored in `messageRef`). Non-SUCCESS status or
conflicting IDs stay `uncertain`. The `+messages-mget` readback returns
top-level `messages[]` with `messageId` and **space-joined text** (newlines
do not survive), and carries **no receiver field**: verification is
`senderId == self_open_id` (the row must be our own self-send produced by
the pinned send task) plus whitespace-normalized exact text; a
`receiverOpenDingTalkId`, if a future API adds one, is still honored.
The flattened event **envelope** was verified live on a real IM event:
top-level `type` equals the event key, business fields are snake_case. The
OA-specific flattened field names (`process_instance_id`, `process_code`)
remain fail-closed (`invalid_event` / `not_leave`, never a send) until the
first real approval event confirms them.

`error`, `filtered`, `uncertain`, and `sent` records are terminal for automatic
processing. Operator reconciliation is required for uncertain sends or schema
errors; do not delete dedup state to force another send. A `pending` record is
safe to send on a subsequent event for the same pinned instance. There is no
startup sweep/backfill; interrupted pending work remains visible in status.

## Offline verification

From this directory:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest -v test_leave_forwarder
```

All DWS calls are fake. Lifecycle tests run only local Python fake streams,
including SIGTERM against an isolated fake daemon and child cleanup. Temporary
state lives under `TMPDIR` (Hermes scratch fallback), is private, and is cleaned
up. Tests cover schema fail-closed, non-leave/unknown/parent applicants,
privacy minimization, exact verification, duplicates/restarts, crash and timeout
uncertainty/no retry, private permissions/process locking, check/status/preview,
ready gating, subscription failure, and graceful shutdown.
