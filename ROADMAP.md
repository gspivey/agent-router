# ROADMAP

Ordered work queue for agent-router sessions. This is the serialized, dependency-ordered
form of the project's specs and backlog: one list of PR-sized items an agent ships **one at
a time**.

**How an agent uses this file:** pick the **first item whose checkbox is unchecked**
(`- [ ] Complete`), implement exactly that one item, and read every file named on the item's
`Spec:` line *before* writing any code. When CI is green, tick the item's box with the PR
number (`- [x] Complete · PR: #<n>`), tick the matching checkboxes in the referenced
`tasks.md` (where one exists), and squash-merge the branch into `development`. **One item per
session — never start a second.** The full session contract lives in
[`prompts/agent-router.md`](prompts/agent-router.md); the conventions and branch model live
in [`AGENTS.md`](AGENTS.md).

Each item is sized for a single reviewable PR (roughly 300–500 lines of new or modified code,
tests included) and is topologically ordered: by the time an agent reaches an item, every
prerequisite it builds on has already merged to `development`. Items are sourced two ways:

- **Spec-backed items** cite a Kiro spec directory and `tasks.md` sub-task numbers, e.g.
  `Spec: .kiro/specs/browser-test-harness/ · tasks 1.1, 2.1`. Read the spec's
  `requirements.md`, `design.md`, and `tasks.md` before coding, and tick the cited sub-tasks
  on merge.
- **Backlog-backed items** cite a `BACKLOG.md` mini-spec, e.g. `Spec: BACKLOG.md § P1.5`.
  The mini-spec is the contract; there is no `tasks.md` to tick, only the ROADMAP checkbox.

For the method used to turn a Kiro spec into queue items, see
[`docs/roadmap-from-kiro-specs.md`](docs/roadmap-from-kiro-specs.md). Strategic phase
direction (what this all builds toward) lives in [`PRODUCT.md`](PRODUCT.md); tactical
mini-specs live in [`BACKLOG.md`](BACKLOG.md).

---

## Active Roadmap

### 3. Allow cron re-fire after an abandoned session

Relax the clean-state guard in the cron-fire handler (`handleCronFire`, `src/index.ts` ~line
191) so it permits a last session whose status is `abandoned`, not only `completed`. An
`abandoned` status means the daemon restarted mid-session (operator action), not that the
agent failed — so it must not block the next scheduled run. Add a Tier 1 test that the guard
allows re-fire after `abandoned` and still blocks after a genuine `failed`.

- Spec: `BACKLOG.md § P1.8`
- [ ] Complete · PR: —

---

### 4. Reject non-JSON webhooks cleanly

Make the `/webhook` handler in `src/server.ts` reject a request whose `Content-Type` is not
JSON with a `400` before attempting to parse, rather than failing inside `JSON.parse`. The
daemon must stay up. Add a Tier 1 test posting `application/x-www-form-urlencoded` and
asserting a `400` with a clear error body.

- Spec: `BACKLOG.md § P2.7`
- [ ] Complete · PR: —

---

### 5. `ls` pagination

Give `agent-router ls` (`bin/agent-router.ts`, `cmdLs`) a default cap of 20 rows with active
sessions always shown, an `--all` flag to print everything, and a `--limit N` override.
Pure CLI change, no daemon involvement. Add Tier 1 tests for the row-selection logic
(default cap, `--all`, `--limit`, active-always-shown).

- Spec: `BACKLOG.md § P2.11`
- [ ] Complete · PR: —

---

### 6. Session-id prefix matching and `--full`

Let every CLI subcommand that takes a session-id (`tail`, `terminate`, `complete-session`,
`kill`) accept any unambiguous prefix of the full UUID, erroring with the candidate list on an
ambiguous prefix and erroring on no match. Add `agent-router ls --full` to print untruncated
IDs while keeping the truncated default. Extract a pure `resolveSessionId(prefix, candidates)`
function and Tier 1-test the unique / none / ambiguous cases. Builds on the `ls` flag parsing
from item 5.

- Spec: `BACKLOG.md § P2.8`
- [ ] Complete · PR: —

---

### 7. `kill` subcommand

Add `agent-router kill <session-id> [--reason <reason>]` (`bin/agent-router.ts` + the IPC
handler) that drives the existing terminate flow, defaulting `termination_reason` to
`killed_by_operator` (add it to the closed union in `src/session-files.ts`). Error if the
session is not active. Reuses the prefix resolver from item 6. Add a Tier 2 test that `kill`
ends a live session and writes the reason.

- Spec: `BACKLOG.md § P2.5`
- [ ] Complete · PR: —

---

### 8. `tail` renders agent text

Fix the `tail` pretty-printer (`prettyPrint` in `bin/agent-router.ts`) so a plain (non-`--raw`)
tail shows the agent's actual output. Agent message text arrives in the entry's `content`
field, which the current printer renders only for error/stderr entry types while agent
messages fall back to `message`. Render `content` for agent-message entries too. Add Tier 1
tests covering each entry shape (agent message, error, tool call).

- Spec: `BACKLOG.md § P2.12`
- [ ] Complete · PR: —

---

### 9. `GET /health` endpoint

Add a `GET /health` route to the daemon's HTTP server (`src/server.ts`) returning `200` with
`{ status: "ok", uptime_seconds, active_sessions, db_ok }`, and `503` when the database is
unreachable. The handler is a pure function over injected daemon state so it Tier 1-tests
directly (ok shape, db-down → 503).

- Spec: `BACKLOG.md § P1.5`
- [ ] Complete · PR: —

---

### 10. Track merge timestamp

Add an optional `merged_at?: number` to each `prs[]` entry in `SessionMeta`
(`src/session-files.ts`) and have the auto-completion path (the `merged` termination handler)
set it. Add `agent-router ls --merged` to filter to sessions that shipped a PR. Tier 1-test
the metadata write; Tier 2-test that a synthetic merge populates `merged_at`.

- Spec: `BACKLOG.md § P2.2`
- [ ] Complete · PR: —

---

### 11. Session-end notification webhook

Add a `notifyOnSessionEnd: { url: string, events: string[] }` config field (`src/config.ts`)
and have the daemon POST `{ session_id, status, termination_reason, prs, started_at,
ended_at }` to the URL when a session ends with a matching termination reason. Best-effort:
log and continue on failure, never block cleanup. Tier 2-test against a mock HTTP server,
asserting the payload and that a failed POST does not stall termination.

- Spec: `BACKLOG.md § P1.3`
- [ ] Complete · PR: —

---

### 12. PAT expiry alerting

Add an optional `token_expires_at` (ISO 8601) config field and a startup + 24h-interval check
that logs `warn` at 14 and 7 days out, `error` at 2 days and after expiry. Document the
rotation procedure in `README.md` on the same branch. Builds on the notification webhook from
item 11 (reuse it to surface the alert). Tier 1-test the days-to-severity mapping as a pure
function.

- Spec: `BACKLOG.md § P2.0`
- [ ] Complete · PR: —

---

### 13. Prompt-injection input guards

Wrap untrusted-source fields (webhook comment bodies, titles, check-run summaries) in
`<<UNTRUSTED_INPUT>>…<</UNTRUSTED_INPUT>>` markers inside the prompt composers in
`src/prompt.ts`, prepend a preamble instructing the agent to treat delimited content as data
not instructions, and cap each field at 2KB with a truncation marker. Tier 1-test that a large
hostile field is truncated, wrapped, and preceded by the preamble.

- Spec: `BACKLOG.md § P3.2`
- [ ] Complete · PR: —

---

### 14. Browser harness: module resolution and `disconnectAll`

Stand up the Playwright tier. Install `@playwright/test` as a devDependency, add
`playwright.config.ts` (`testDir: ./test/browser`, `.spec.ts` match, chromium headless,
`workers: CI ? 1 : 4`), and a `test/browser/smoke.spec.ts` that imports `createWebApp` from
`../../src/web-server.js` to prove `.js`→`.ts` resolution under Playwright's loader. Add
`disconnectAll(sessionId)` to the `SSEBroker` interface and `createSSEBroker`
(`src/sse-broker.ts`) — close all clients, clear the poll timer and heartbeat state, write no
`session_ended` event — to enable reconnect testing. Foundation for the harness items that
follow.

- Spec: `.kiro/specs/browser-test-harness/` · tasks `1.1`, `2.1`
- [ ] Complete · PR: —

---

### 15. Browser harness: fixtures and server lifecycle

Create `test/browser/fixtures.ts` with the full per-test server lifecycle (tmpdir → session
files → db → logger → token store → SSE broker → FakeKiroBackend → session manager → web app →
`startWebServer` on an ephemeral port), the TCP readiness check, teardown, the `ConsoleCollector`
(console errors, page errors, dialogs), and the `seedSession` helper with its `live: false`
(filesystem-only) and `live: true` (`slow-multi-prompt.json` scenario) modes. The page fixture
must not auto-navigate. Builds on item 14's harness scaffold; unblocks all spec files.

- Spec: `.kiro/specs/browser-test-harness/` · tasks `3.1`
- [ ] Complete · PR: —

---

### 16. Browser harness: list, detail, SSE-render, and auth tests

Add the read-path spec files against the fixtures from item 15: `list-view.spec.ts` (status
badges render, no console errors), `detail-view.spec.ts` (row click → hash route, not-found
state, back to list), `sse-render.spec.ts` (appended `stream.log` entries render in ID order,
auto-scroll, `session_ended` hides controls), and `auth-token.spec.ts` (token present when
`bindPublic: false`, absent when `true`). All use `seedSession({ live: false })`.

- Spec: `.kiro/specs/browser-test-harness/` · tasks `5.1`, `6.1`, `7.1`, `13.1`
- [ ] Complete · PR: —

---

### 17. Browser harness: reconnect, inject, and kill tests

Add the interactive spec files: `sse-reconnect.spec.ts` (drop via `disconnectAll`, reconnect
with `Last-Event-ID`, no duplicate IDs, no reconnect after `session_ended`, delay reset),
`inject-prompt.spec.ts` and `kill-session.spec.ts` (both `seedSession({ live: true })` with the
`slow-multi-prompt.json` scenario — inject yields a `web_inject` stream entry and clears the
textarea; kill confirms, terminates with `terminated_web`, hides controls). Builds on items
14–16.

- Spec: `.kiro/specs/browser-test-harness/` · tasks `8.1`, `9.1`, `10.1`
- [ ] Complete · PR: —

---

### 18. Browser harness: visibility reconnect and `test:browser` script

Add `visibility-reconnect.spec.ts` using a CDP session and `Page.setWebLifecycleState`
(hidden → active triggers a reconnect with the last event ID; entries appended while hidden
appear on resume; no duplicate IDs). Wire `"test:browser": "npx playwright test"` into
`package.json`, and verify `npm test` (vitest) does not pick up `.spec.ts` files and that no
other test tier or config is modified. Closes out the browser-test-harness spec.

- Spec: `.kiro/specs/browser-test-harness/` · tasks `12.1`, `14.1`
- [ ] Complete · PR: —

---

### 19. Session resumption across daemon restarts

Add `kiro_session_id?: string` to `SessionMeta` (`src/session-files.ts`), persist it to
`meta.json` after ACP `session/create` (`src/session-mgr.ts`), and on daemon startup attempt
ACP `session/load(kiro_session_id)` (already present at `src/acp.ts`) for each session still
marked `active`: keep it active if load succeeds, otherwise mark `terminated_by_restart` (new
closed-union reason). This makes restarts non-destructive and complements item 3's cron guard.
Tier 2-test: spawn, kill the daemon mid-session, restart, assert clean resume-or-terminate.

- Spec: `BACKLOG.md § P2.1`
- [ ] Complete · PR: —

---

### 20. Git worktrees per session

Add `src/worktree-manager.ts`: ensure a canonical clone per repo under
`~/.agent-router/repos/<owner>/<repo>`, create a session worktree via `git worktree add` (its
own branch off the default branch), and `git worktree remove --force` on any termination.
Replace the per-session `git clone` with a daemon-provided `WORKDIR` pointing at the worktree.
This obsoletes interim collision detection (P0.4) and shares `.git/objects` across runs.
Tier 2-test: two simultaneous sessions on one repo get isolated worktrees and both clean up.

- Spec: `BACKLOG.md § P1.7`
- [ ] Complete · PR: —

---

## Completed

Items move here after they merge to `development`.

### 2. Idempotent PR registration

Change `registerPR` in `src/db.ts` from a plain `INSERT` to an upsert (`INSERT … ON CONFLICT
(repo, pr_number) DO UPDATE` or `INSERT OR REPLACE`) so a new session can claim a `(repo, pr)`
already held by a completed or dead session. Today the `INSERT` fails the `UNIQUE(repo,
pr_number)` constraint, `meta.json` updates but the SQLite row still points at the old
session, and inbound webhooks route to the void. Add a Tier 1 test (re-register from a second
session wins) and a Tier 2 test (webhook for the PR routes to the new session after
re-registration).

- Spec: `BACKLOG.md § P2.13`
- [x] Complete · PR: #37

---

### 1. Trim environment variable values

Add `.trim()` to resolved environment-variable values in `resolveEnvValues` (`src/config.ts`,
~line 69) so trailing whitespace from a systemd `EnvironmentFile` can no longer silently
corrupt a secret (a trailing newline on `GITHUB_TOKEN` produces opaque 401s). A focused Tier 1
test feeds a value with surrounding whitespace and asserts the resolved value is trimmed. This
is the foundation item — small, self-contained, and proves the self-build loop end to end.

- Spec: `BACKLOG.md § P2.10`
- [x] Complete · PR: #36
