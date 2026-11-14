# Roadmap

TableRecords is a local, single-GM tool today. The next versions are about letting a real table share it without giving up the local-first parts that make it useful.

This is a direction, not a promise. Order can change when a security problem shows up.

## Guiding rules

- Local first. Cloudflare is an access layer, not a new home for the data.
- Consent before capture, sharing, or transcription.
- Private GM material stays private by default. A player should never see a note because a permission check was missed.
- One table should not be able to read another table.
- No silent background AI. Model calls stay explicit and queue behind capture work.
- Export remains plain files.

## Next

### 1. Accounts, sessions, and roles

Today the dashboard uses one `DASHBOARD_TOKEN`. That is enough for one GM on one machine. It is not enough for multiple GMs, players, or share links.

What I want:

- Add invite-only local accounts.
- Hash passwords with a memory-hard KDF.
- Use HttpOnly, Secure, SameSite session cookies.
- Rate-limit and lock out repeated failed logins.
- Support owner, GM, co-GM, player, and viewer roles.
- Let a user belong to more than one table.
- Add passkeys/WebAuthn after the password flow is stable.
- Accept Cloudflare Access as an optional front door and map its email to a local user.

Acceptance:

- A user can belong to more than one table with different roles.
- Revoking a session takes effect immediately.
- The owner can list and revoke active sessions.
- Login, logout, invite, revoke, and permission checks have tests.
- No API route trusts a role from the request body.

### 2. Bridge control hardening

The bridge now has start, pause, resume, and stop controls. They work on loopback today, but they trust the bridge token. That token is a Foundry world setting, so other clients can read it. The Foundry UI only shows the buttons to a GM, but the server cannot verify the Foundry role.

A client that can reach the dashboard with that token could pause or stop a recording. Do not expose these controls through Cloudflare, or use them on a shared machine, until this work is done.

The current trust model is one GM, one trusted machine, and a loopback dashboard.

Planned:

- Generate a separate control secret.
- Store the control secret as a Foundry client setting on the GM client, not as a world setting.
- Keep the world bridge token for live chat, rolls, and state only.
- Require the control secret for start, pause, resume, and stop.
- Restrict the control route to the exact Foundry origin instead of wildcard CORS.
- Add a cooldown and a per-minute rate limit.
- Allow one control action at a time.
- Ask for confirmation before pause or stop. Pause discards the in-progress partial clip.
- Write an audit marker or timeline event with the action, time, and Foundry user.
- Add tests for missing token, wrong token, replayed requests, rate limits, and concurrent actions.

Acceptance:

- The world-readable bridge token cannot start, pause, resume, or stop a recording.
- The control secret is not shown in world settings, logs, or screenshots.
- A request from another origin is rejected.
- Repeated control requests return 429 after the limit.
- Control actions appear in the session timeline.
- Pause and stop require a deliberate confirmation.

### 3. Cloudflare support

The goal is remote access without opening a port on the house network.

Planned:

- Documented `cloudflared tunnel` setup for the dashboard.
- Optional Cloudflare Access JWT validation.
- A `PUBLIC_BASE_URL` setting for absolute links and cookies.
- Correct proxy, origin, and secure-cookie handling when behind a tunnel.
- SSE and WebSocket compatibility through Cloudflare.
- Optional encrypted backup to R2. Off by default.
- A clear warning that a tunnel exposes the dashboard to the internet and must sit behind Access or the built-in auth.

Not planned:

- Moving session audio or the database to Cloudflare by default.
- A hosted multi-tenant version.
- Using Cloudflare as a transcription or model provider.

Acceptance:

- A tunneled dashboard works with Access enabled and rejects requests without a valid JWT.
- The dashboard still binds to loopback and still works without Cloudflare.
- A signed-out user cannot reach an API route.
- Share links work through the tunnel without exposing the admin UI.

### 4. Multiple sessions and tables

The recorder is built around one active session. A table with two games, a pickup session, or a co-GM needs more.

Planned:

- A **table** owns a Discord guild, a Foundry world, a roster, and a set of sessions.
- A **campaign** groups tables or seasons when a group changes games.
- More than one active capture, with one recorder per voice channel.
- A session can move between tables only by an owner action.
- Per-table defaults for system, time zone, retention, and visibility.

Acceptance:

- Two tables can record at the same time without mixing manifests, audio, or people.
- A session always resolves to exactly one table.
- Deleting a table does not delete another table's data.
- Existing single-table installs migrate without changing session IDs.

### 5. Resource queue

The current job runner is FIFO per app. Multiple sessions and local models need a queue that knows what hardware a job uses.

Planned resource classes:

- `capture`: always allowed, never blocked by background work.
- `gpu`: STT batches and local model calls, one at a time by default.
- `cpu`: merge, render, waveform, and file work.
- `network`: Foundry import and optional cloud calls.

Planned controls:

- Global and per-table queues.
- Priority for live work over backfill.
- Pause and resume.
- Fair scheduling so one table cannot starve another.
- Concurrency limits per resource.
- Queue position, ETA, and cancellation in the UI.
- A model server can be started once and shared by queued summaries.

Acceptance:

- A long transcription cannot block a live capture stop.
- Two tables can queue work without one taking every GPU slot.
- A cancelled job releases its slot.
- Queue state survives a restart.
- The UI shows which resource a job is waiting for.

### 6. Multi-GM and visibility

A table often has a GM and one or more co-GMs, plus players who should see only part of the record.

Planned permission matrix:

| Capability | Owner | GM | Co-GM | Player | Viewer |
|---|---|---|---|---|---|
| Manage users and tables | yes | no | no | no | no |
| Start and stop capture | yes | yes | yes | no | no |
| Import Foundry | yes | yes | yes | no | no |
| Edit session notes | yes | yes | yes | no | no |
| Read GM notes | yes | yes | yes | no | no |
| Read own character notes | yes | yes | yes | yes | no |
| Listen to review audio | yes | yes | yes | optional | optional |
| Create share links | yes | yes | optional | no | no |
| Delete sessions | yes | optional | no | no | no |

Visibility should be set per artifact, not only per session:

- Audio: private, table, link.
- Transcript: private, table, link.
- Rolls: table by default.
- GM notes and mental notes: GM only by default.
- AI summaries: GM only until shared.

Acceptance:

- A player cannot fetch another player's private audio by changing an ID.
- A co-GM can run a session but cannot add users.
- Every read route checks table membership and artifact visibility.
- Permission changes are written to an audit log.

### 7. Share links

Share links should let a player read a recap without an account, while keeping the rest private.

Planned:

- Opaque link ID plus an HMAC signature.
- Expiry and manual revoke.
- Scope selection: summary, transcript, rolls, or audio.
- Optional passphrase.
- Read-only page with no dashboard navigation.
- Download limits and access counts.
- Default: no audio, no GM notes, no player names unless the GM selects them.
- Links can be disabled for a whole table at once.

Acceptance:

- A tampered signature is rejected.
- An expired or revoked link returns a clear 404/410 page.
- A share token cannot call admin APIs.
- The owner can see and revoke every active link.
- Shared pages send `noindex` and no referrer.

## Later

- Build a tablet-first PWA with offline-safe session notes.
- Add a player recap page with their character, visible clues, and next-session time.
- Let a table schedule sessions and send Discord reminders.
- Search across summaries, clues, and transcripts.
- Back up encrypted local data and restore it in one action.
- Set per-table retention rules, including audio-only cleanup.
- Record views, downloads, shares, and permission changes in an audit log.
- Expose webhooks and a small read API for Foundry and other tools.
- Add more system adapters while keeping the generic fallback.
- Make AI role-aware: a player-facing recap must not receive GM-only context.
- Choose the model by queue and scope: small for recent recaps, large for whole-session work.

## Not planned

- Do not add cloud transcription.
- Do not host table audio on a shared service.
- Do not record without consent.
- Do not publish a public session directory.
- Do not run background AI calls that are not attached to a visible request.

## How to help

If you run a table with more than one GM, or you need remote access through Cloudflare, open an issue with the shape of your table:

- How many GMs and players?
- One table or several?
- Which parts need to stay GM-only?
- Do players need accounts, or are read-only links enough?
- Is Cloudflare Access already in use?

That is enough to prioritize the next slice.
