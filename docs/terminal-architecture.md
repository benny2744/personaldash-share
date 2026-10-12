# Web Terminal Architecture

Native browser terminal (xterm.js) with server-side SSH to administrator-assigned
hosts. This document is the design record for the feature shipped in
`services/terminal-gateway` + `/terminal` + `app/api/terminal/*`.

## 1. Found architecture (what the terminal builds on)

| Concern | Existing state | Decision |
|---|---|---|
| Authentication | **None in-app.** No User model, no login, no sessions. Protection is deployment-level: Cloudflare Tunnel/Access → Caddy loopback router (:3001) → WorkDash (:3003). | Identity is read from a trusted proxy header (default `Cf-Access-Authenticated-User-Email`) with a configured local fallback. No second auth system is created. |
| WebSocket transport | Next.js standalone route handlers cannot accept WS upgrades. The estate already solves this twice with a **sidecar + HMAC lease + Caddy route** (pipecat-voice :3015, qwenaudio :3101). | Third instance of the pattern: `terminal-gateway` sidecar on :3016, Caddy route `/api/terminal/ws`. |
| Session/lease precedent | `lib/hermes/voiceLease.js` — HMAC-SHA256 signed, base64url, `iat`/`exp`/`jti`, timing-safe compare. | `lib/terminal/lease.js` mirrors the exact envelope with a terminal-specific payload. |
| Data layer | Prisma 7 + Postgres; timestamped migration folders. | `terminal_hosts` + `terminal_sessions` tables; sidecar reads them over `pg` raw SQL (same precedent as `lib/gbrain/db.js`). |
| Config | Settings registry (`lib/settings/registry.js`, DB > env > default). | `terminal.*` settings keys with `TERMINAL_*` env fallbacks. |
| CSRF/mutation guard | `lib/settings/requestGuard.js` (`configurationRequestError`). | Applied to every terminal REST mutation. |
| Frontend terminal | Hermes web uses `@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0`. | Same versions. |

## 2. Components

```
Browser (xterm.js, /terminal)
   │  REST: POST /api/terminal/sessions        ──▶ WorkDash (Next)
   │        ◀── { sessionId, lease, wsPath }        • identity resolution
   │                                                • canAccessHost (authz)
   │                                                • settings limits
   │                                                • TerminalSession row (pending)
   │                                                • lease issue (30 s TTL)
   ▼  WS: /api/terminal/ws?session&lease  (Caddy strip → :3016)
terminal-gateway sidecar
   • verifyTerminalLease (HMAC, timing-safe)
   • load session + host from Postgres (pg pool)
   • re-check canAccessHost + session ownership + status
   • load key file by credentialRef (read-only mount, never the app)
   • ssh2 connect → pinned host-key fingerprint (SHA256, constant-time)
   • shell({ TERM: 'xterm-256color', cols, rows })
   • JSON frame bridge + idle/max timers + grace reattach
   • audit metadata (no content capture)
   ▼ SSH
Assigned host / VM
```

## 3. Identity & authorization

- `resolveTerminalIdentity(request)` (lib/terminal/identity.js):
  1. Trusted header value if present and well-formed (lowercased email-like).
  2. `TERMINAL_LOCAL_IDENTITY` fallback (loopback/dev use).
  3. Otherwise `null` → every route answers 401; feature refuses to operate.
- Admins: `TERMINAL_ADMIN_IDENTITIES` (comma-separated). Admins can manage the
  host registry and reach every host.
- `canAccessHost(identity, host, { isAdmin })` — the single authorization
  primitive. `true` iff admin OR `identity ∈ host.allowedIdentities`.
  An empty `allowedIdentities` therefore means **admins only**.
- Enforced **twice**: REST session creation (app) and WS attach (sidecar,
  independently re-reading the DB). Compromise of one tier does not grant access.

### Trust boundary note

Header-based identity trusts whatever terminates TLS in front of Caddy. A caller
with arbitrary host-local access could spoof the header on :3001 — but host-local
access already grants full unauthenticated app access, so this adds no new
capability. Cloudflare Access remains the real gate for remote callers.

## 4. Credentials

- `SshCredentialProvider` interface (`lib/terminal/credentials.js`); V1 impl is
  `FileKeyProvider`: `credentialRef` (validated `^[a-z0-9][a-z0-9-]{0,63}$`)
  maps to `<keyDir>/<ref>_ed25519` (also accepts `_rsa`/`_ecdsa`).
- The key directory is mounted **read-only into the sidecar only**
  (`TERMINAL_KEY_DIR`, default `/run/terminal-keys`). Key material never enters
  the app container, the database, the settings store, or the browser.
- Key generation (runbook): `ssh-keygen -t ed25519 -f ~/secrets/terminal-keys/default_ed25519 -N ''`
  with the public half installed in each target host's `authorized_keys`.

## 5. Host-key verification (mandatory, fail-closed)

- `terminal_hosts.host_key_sha256` stores `SHA256:<base64>` (same format as
  `ssh-keygen -lf`).
- The sidecar computes the SHA256 fingerprint of the host key presented during
  the SSH handshake and constant-time-compares it. Mismatch **or missing pin**
  → connection refused, session marked `failed`, audit event `terminal.hostkey.rejected`.
- Enrollment is an explicit two-step: admin clicks **Learn fingerprint**
  (Settings UI) → sidecar dials the host, returns the fingerprint only → admin
  confirms out-of-band → pin saved. There is no auto-trust path (no TOFU).

## 6. WS protocol

JSON text frames. `data` fields are base64 (binary-safe paste/output).

| Direction | Frame |
|---|---|
| c→s | `{type:'input', data}` (base64, ≤64 KiB decoded) |
| c→s | `{type:'resize', cols, rows}` (integers 2–500) |
| c→s | `{type:'ping'}` |
| s→c | `{type:'output', data}` |
| s→c | `{type:'status', state, message?}` — `connecting|active|grace|closed|failed` |
| s→c | `{type:'exit', code?, reason}` |
| s→c | `{type:'pong'}` / `{type:'error', message}` |

Unknown client frame types are ignored (logged once). Invalid frames → socket
closed with an `error` frame. One attached socket per session: attach while
`active` is rejected; attach during `grace` re-attaches.

## 7. Session lifecycle

```
REST create ─▶ pending ─WS attach─▶ active ─browser gone─▶ grace ─re-attach─▶ active
                 │ lease TTL 30 s      │ idle timeout        │ 60 s            │
                 ▼                     ▼ max duration        ▼ expires         ▼
               expired→closed        closed                closed            …
DELETE /api/terminal/sessions/:id → closed (user-initiated)
ssh2 channel close / error → closed | failed
```

- Timers: idle (no *input* frames), absolute max duration, grace. All from
  `terminal.*` settings (read fresh per session create; sidecar caches ~30 s).
- V1 has no tmux/persistence: once the grace window lapses the SSH channel is
  closed and the shell is gone. This is documented product behavior.
- Single-use leases: a lease is bound to (sessionId, identity); status-machine
  transitions make replay ineffective (`pending`→`active` only once; `grace`
  re-attach requires the same identity that owns the session).

## 8. Limits (settings registry, hot scope)

| Key | Env fallback | Default |
|---|---|---|
| `terminal.enabled` | `TERMINAL_ENABLED` | false |
| `terminal.maxSessionsPerIdentity` | `TERMINAL_MAX_SESSIONS_PER_IDENTITY` | 3 |
| `terminal.idleTimeoutSeconds` | `TERMINAL_IDLE_TIMEOUT_SECONDS` | 900 |
| `terminal.maxSessionSeconds` | `TERMINAL_MAX_SESSION_SECONDS` | 28800 |
| `terminal.graceSeconds` | `TERMINAL_GRACE_SECONDS` | 60 |
| `terminal.leaseTtlSeconds` | `TERMINAL_LEASE_TTL_SECONDS` | 30 |

## 9. Audit

Both tiers log one structured JSON line per transition
(`terminal.session.created|attached|detached|closed|failed`,
`terminal.hostkey.rejected`, `terminal.authz.denied`) with
`sessionId, identity, hostSlug, reason, ts, bytesIn, bytesOut`.
**No keystrokes, no output content** — counters only. `terminal_sessions`
rows carry the same metadata for the Settings UI / later review.

## 10. Threat model summary

| Threat | Mitigation |
|---|---|
| Unauthorized host access | `canAccessHost` at REST **and** WS attach; 403/401 semantics; admins gated by configured list |
| Lease theft/replay | 30 s TTL, HMAC, bound to session+identity, status machine single-attachment |
| Credential exfiltration | Keys only in sidecar read-only mount; never serialized, logged, or sent to browser |
| MITM / rogue host | Mandatory pinned SHA256 host-key fingerprint, constant-time compare, no TOFU |
| Runaway sessions | Per-identity cap, idle + absolute timeouts, server-enforced |
| Cross-site writes | `configurationRequestError` on all terminal mutations |
| Content surveillance | No capture; counters + metadata only |
| DoS via frames | 64 KiB frame cap, resize bounds, input backpressure (sidecar drops when SSH buffer saturated) |
