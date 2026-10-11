# SPA Operator Dashboard Restoration — Requirements

## Background

The Svelte 5 SPA overhaul (ROADMAP items 71-78) replaced the `src/web-ui.ts`
monolith with a mobile-first chat client. The overhaul improved the session
reading experience but dropped the operator/admin layer without explicit sign-off
on those removals. This spec restores what was lost and adds improvements where
the old monolith was weak.

---

## Functional Requirements

### FR-1: Session Card Metadata

**FR-1.1** — The session card SHALL display a short session ID composed of the
first 8 characters of the session UUID, rendered in a monospace font, in a muted
color.

**Acceptance criteria:**
- AC-1.1a: Given a session with `session_id` `"abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`, the card SHALL render `"abc12345"` in `font-family: monospace` with `var(--text-muted)` coloring.
- AC-1.1b: The short ID SHALL be present on every session card regardless of session status.

**FR-1.2** — For sessions with a non-empty `prs` array, the session card SHALL
display each PR as a link labeled `PR #<number>` pointing to the GitHub PR URL
(`https://github.com/<repo>/pull/<pr_number>`). Multiple PRs SHALL be rendered
as comma-separated links.

**Acceptance criteria:**
- AC-1.2a: Given `prs: [{repo: "owner/repo", pr_number: 42}]`, the card SHALL render an anchor `<a href="https://github.com/owner/repo/pull/42">PR #42</a>`.
- AC-1.2b: Given `prs: [{...pr_number: 1}, {...pr_number: 2}]`, the card SHALL render `"PR #1, PR #2"` (both links).
- AC-1.2c: Given `prs: []`, the card SHALL render no PR links.
- AC-1.2d: PR link anchors SHALL have `target="_blank" rel="noopener noreferrer"`.

**FR-1.3** — For sessions where `termination_reason` is non-null AND `status`
is not `active`, the session card SHALL display the termination reason as a muted
pill.

**Acceptance criteria:**
- AC-1.3a: Given `termination_reason: "merged"` and `status: "completed"`, the card SHALL render a pill containing `"merged"`.
- AC-1.3b: Given `termination_reason: null`, the card SHALL render no termination pill.
- AC-1.3c: Given `status: "active"`, the card SHALL render no termination pill even if `termination_reason` is non-null.

**FR-1.4** — For ended sessions (status is `completed`, `abandoned`, or
`failed`) where both `created_at` and `completed_at` are present, the session
card SHALL display the duration formatted as `"Xm"` for durations under 60
minutes or `"Xh Ym"` for durations of 60 minutes or more.

**Acceptance criteria:**
- AC-1.4a: Given `created_at: 1000` and `completed_at: 1780`, the card SHALL render `"13m"` (780 seconds = 13 minutes).
- AC-1.4b: Given `created_at: 0` and `completed_at: 3900`, the card SHALL render `"1h 5m"`.
- AC-1.4c: Duration SHALL NOT be shown on active sessions or sessions with `completed_at: null`.

---

### FR-2: Repo-Grouped Session List

**FR-2.1** — The session list view SHALL group sessions by their `repo` field,
replacing the current flat list. Each group SHALL be rendered as a collapsible
`RepoGroup` component with a header row and a body containing session cards for
that repo.

**Acceptance criteria:**
- AC-2.1a: Given sessions for repos `"gspivey/edit-director"` and `"gspivey/agent-router"`, the list SHALL render exactly two group headers.

**FR-2.2** — The RepoGroup header SHALL show:
- The repo name as `owner/repo`.
- An open PR count badge that links to `https://github.com/owner/repo/pulls` when `open_pr_count > 0`.
- A cron info pill: if a cron exists for this repo and is not paused, show `"<schedule> · next in Xm"` or `"<schedule> · next in Xh Ym"`; if paused, show `"paused"` pill.
- A pulsing green dot indicator when the group has any active sessions.

**Acceptance criteria:**
- AC-2.2a: Given `open_pr_count: 3` for repo `"gspivey/foo"`, the header SHALL render a link `<a href="https://github.com/gspivey/foo/pulls">3 PRs</a>`.
- AC-2.2b: Given `open_pr_count: 0`, no PR badge SHALL be rendered.
- AC-2.2c: Given `cron: { schedule: "*/30 * * * *", paused: false, next_fire: "2026-10-11T03:00:00Z" }` and now is `2026-10-11T02:57:00Z`, the header SHALL show `"*/30 * * * * · next in 3m"`.
- AC-2.2d: Given `cron: { paused: true }`, the header SHALL show a `"paused"` pill.
- AC-2.2e: Given any active session in the group, the header SHALL show a pulsing green dot (`animation: pulse`).
- AC-2.2f: When `cron` is `null`, no cron info SHALL be shown.

**FR-2.3** — The data source for the grouped list SHALL be `GET /repos/sessions`,
which returns `{ repos: RepoGroup[] }`. The client SHALL NOT reconstruct grouping
from the flat `/sessions` endpoint.

**Acceptance criteria:**
- AC-2.3a: On mount, `SessionList` SHALL issue exactly one request to `GET /repos/sessions`.
- AC-2.3b: No request to `GET /sessions` SHALL be made from the grouped session list view.

**FR-2.4** — Each group body SHALL show all active sessions unconditionally and
initially show the 5 newest terminal sessions (the 5 with the highest `created_at`
values). A `"Show N more"` button SHALL appear when
`terminal_total > terminal_sessions.length`. Clicking it SHALL request
`GET /repos/:repo/sessions?limit=5&offset=<current_count>` and append results.
The server-side paged endpoint returns only terminal sessions; the `total` field
in its response equals `terminal_total`.

**Acceptance criteria:**
- AC-2.4a: Given `terminal_total: 8` and `terminal_sessions` length 5, the group SHALL render a `"Show 3 more"` button.
- AC-2.4b: Given `terminal_total: 3` and `terminal_sessions` length 3, no "Show more" button SHALL be shown.
- AC-2.4c: After clicking "Show more", the appended sessions SHALL appear below the existing ones without replacing them, de-duplicated by `session_id`.
- AC-2.4d: The "Show more" button SHALL be disabled while its request is in flight.

**FR-2.5** — Collapse state per repo key SHALL be persisted to `localStorage`
under the key `"ar-repo-collapsed-<repo>"` (where `<repo>` is
`encodeURIComponent(repo)`). A repo absent from localStorage SHALL default to
expanded. The value `"1"` means collapsed; the value `"0"` means explicitly
expanded (user previously expanded the group). A missing key means the user has
never toggled and the default (or auto-collapse) applies.

**Acceptance criteria:**
- AC-2.5a: Toggling a group to collapsed SHALL write `"1"` to `localStorage["ar-repo-collapsed-<encodedRepo>"]`.
- AC-2.5b: Toggling a group to expanded SHALL write `"0"` to `localStorage["ar-repo-collapsed-<encodedRepo>"]` (not remove the key).
- AC-2.5c: On mount, groups with `localStorage["ar-repo-collapsed-<encodedRepo>"] === "1"` SHALL render collapsed (body hidden).
- AC-2.5d: On mount, groups with `localStorage["ar-repo-collapsed-<encodedRepo>"] === "0"` SHALL render expanded (auto-collapse SHALL NOT apply).

**FR-2.6** — Auto-collapse: a repo SHALL be automatically collapsed on initial
render if ALL of the following hold: (a) `active_sessions.length === 0`, AND
(b) at least one terminal session exists whose `completed_at` value is non-null
AND `Math.max(...terminal_sessions.map(s => s.completed_at ?? 0))` is a positive
value that is more than 86400 seconds before `Date.now() / 1000`, AND (c) the
repo's localStorage key is absent (key does not exist). Auto-collapse SHALL NOT
apply when the localStorage key exists (regardless of value), or when the repo
has any active sessions.

**Acceptance criteria:**
- AC-2.6a: Given a repo with `active_sessions: []`, all `terminal_sessions` having `completed_at` more than 86400 seconds ago, and no localStorage key set, the group SHALL render collapsed on mount.
- AC-2.6b: Given the same repo but with `localStorage["ar-repo-collapsed-<encodedRepo>"] === "0"` (user previously expanded), auto-collapse SHALL NOT apply.
- AC-2.6c: Given a repo with one active session, auto-collapse SHALL NOT apply regardless of terminal session age.
- AC-2.6d: Given a repo with zero terminal sessions, auto-collapse SHALL NOT apply (condition (b) is not satisfied).

**FR-2.7** — Sessions with `repo: null` SHALL NOT be shown in the grouped list.
The `GET /repos/sessions` endpoint only returns configured repos; null-repo
sessions are internal router sessions not associated with any repository.

**Acceptance criteria:**
- AC-2.7a: The `RepoGroup.repo` field is typed `string` (non-nullable) and no special handling for null repos is needed client-side.

---

### FR-3: Session Detail Metadata Panel

**FR-3.1** — The session detail view SHALL render a collapsible metadata panel
above the chat stream containing:
- Session ID (full UUID, monospace, with a copy-to-clipboard button).
- Status badge (matching existing badge styling).
- Repo (linked to `https://github.com/owner/repo` when non-null).
- Created at (formatted as a locale datetime string).
- Completed at (formatted datetime, shown only when non-null).
- Duration (formatted as `"Xm"` or `"Xh Ym"`, shown only for ended sessions).
- Termination reason (shown only when non-null and status is not active).
- PR links (each as `"PR #<n>"` linking to the GitHub PR URL, shown when `prs` is non-empty).

**Acceptance criteria:**
- AC-3.1a: Given a completed session with all fields set, all eight items SHALL be rendered in the metadata panel.
- AC-3.1b: Given an active session with `completed_at: null` and `termination_reason: null`, completed-at, duration, and termination reason rows SHALL be omitted.
- AC-3.1c: The copy button SHALL write the full session UUID to the clipboard on click.

**FR-3.2** — The metadata panel SHALL be collapsed by default on viewports below
768 px and expanded by default on viewports 768 px and wider. The user SHALL be
able to toggle it at any time. Collapse state SHALL NOT be persisted (reset on
navigation).

**Acceptance criteria:**
- AC-3.2a: On initial render at viewport width < 768 px, the metadata panel body SHALL be hidden.
- AC-3.2b: On initial render at viewport width ≥ 768 px, the metadata panel body SHALL be visible.
- AC-3.2c: Clicking the panel header SHALL toggle the body visibility.

---

### FR-4: Show Internals Toggle

**FR-4.1** — The session detail view SHALL include a `"Show internals"` toggle
(checkbox or toggle button). When OFF (default), stream entries whose `source`
field starts with `"_kiro.dev/"` SHALL be filtered out from the rendered chat.
When ON, those entries SHALL be rendered as the existing `InternalPill`
components.

**Acceptance criteria:**
- AC-4.1a: Given `showInternals = false` (default) and an entry with `source: "_kiro.dev/metadata"`, that entry SHALL NOT be rendered in the chat stream.
- AC-4.1b: Given `showInternals = true`, entries with `source: "_kiro.dev/*"` SHALL be rendered as `InternalPill`.
- AC-4.1c: Toggling from OFF to ON SHALL immediately render all previously-hidden internal entries without a page reload.
- AC-4.1d: The toggle control SHALL be visible in the detail view regardless of session status (active or ended).

**FR-4.2** — The toggle state SHALL be persisted to `localStorage` under the
key `"ar-show-internals"` and restored on mount.

**Acceptance criteria:**
- AC-4.2a: After setting `showInternals = true` and navigating away and back, the toggle SHALL restore to ON.
- AC-4.2b: Absence of the key SHALL default to OFF.

---

### FR-5: Tool Output Truncation

**FR-5.1** — A `ToolCallCard` whose `updates` string contains more than 20
lines (newline-delimited) SHALL initially render only the first 20 lines of
the output, followed by a `"Show N more lines"` button, where N is the total
line count minus 20.

**Acceptance criteria:**
- AC-5.1a: Given `updates` with 25 lines, the card SHALL render 20 lines and a `"Show 5 more lines"` button.
- AC-5.1b: Given `updates` with 20 or fewer lines, no "Show more lines" button SHALL be rendered.
- AC-5.1c: Clicking `"Show N more lines"` SHALL expand the output to show all lines inline; the button SHALL be removed after expansion.
- AC-5.1d: There SHALL be no collapse button after expansion (expand-only).

**FR-5.2** — Truncation SHALL apply only to the tool output body text. The card
header and title SHALL always be visible regardless of truncation state.

**Acceptance criteria:**
- AC-5.2a: When the card is truncated AND collapsed (mobile default), the header SHALL remain visible and interactive.
- AC-5.2b: The spinner state (`spinner={true}`) SHALL interact with truncation: while spinning, the body is hidden (existing behavior); after the spinner clears, truncation SHALL be applied based on the final line count.

---

### FR-6: Kill Session Action

**FR-6.1** — The session detail view SHALL display a red `"Kill"` button for
active sessions alongside the existing `"Interrupt"` button. The Kill button
SHALL NOT be shown for sessions with status other than `active`.

**Acceptance criteria:**
- AC-6.1a: Given `status: "active"`, a `"Kill"` button with `data-testid="kill-button"` SHALL be rendered.
- AC-6.1b: Given `status: "completed"` or `"abandoned"` or `"failed"`, no Kill button SHALL be rendered.

**FR-6.2** — Clicking the `"Kill"` button SHALL display a confirmation dialog
before issuing the API call. The dialog SHALL read: `"Kill this session? This
will terminate the agent process immediately and cannot be undone."` with
`"Kill"` (confirm) and `"Cancel"` (dismiss) buttons.

**Acceptance criteria:**
- AC-6.2a: Clicking `"Kill"` SHALL show the confirmation dialog.
- AC-6.2b: Clicking `"Cancel"` in the dialog SHALL dismiss it without making any API request.
- AC-6.2c: Clicking `"Kill"` in the confirmation dialog SHALL issue `POST /sessions/:id/kill`.
- AC-6.2d: On HTTP 200 from the kill endpoint, the session status SHALL be updated to reflect termination (the SSE stream will deliver the `session_ended` event; no optimistic UI update required).
- AC-6.2e: On API error from the kill endpoint, the dialog SHALL close and an error message SHALL be rendered in a `data-testid="kill-error"` element with `role="alert"` near the Kill button, cleared on a subsequent Kill attempt.

**FR-6.3** — The `"Kill"` button SHALL be styled with `var(--error)` as its
background/accent color, distinct from the `"Interrupt"` button's amber styling.

**Acceptance criteria:**
- AC-6.3a: The Kill button SHALL have CSS applying `background: var(--error)` or equivalent red styling from the existing palette.
- AC-6.3b: The Interrupt button SHALL retain its existing amber styling.

---

### FR-7: Config View

**FR-7.1** — The SPA SHALL expose a `#/config` hash route. The `Header`
component SHALL include a `"Config"` navigation link alongside the current
`"Sessions"` text. The link SHALL use the GitHub dark palette nav-link style
consistent with the existing header.

**Acceptance criteria:**
- AC-7.1a: Navigating to `#/config` SHALL render the Config view.
- AC-7.1b: The header SHALL render two navigation items: `"Sessions"` (links to `#/`) and `"Config"` (links to `#/config`).
- AC-7.1c: The active nav item SHALL be visually distinguished (e.g., background `var(--surface-elevated)` or border-bottom) matching the existing dark GitHub palette.

**FR-7.2** — The Config view SHALL display a `"Token Health"` section containing
a table with columns `Project`, `Token Name`, `Status`, and `Expiry`. Data SHALL
come from the `tokens` array in the `GET /config` response. The `Status` cell
SHALL render a colored dot: green for `health: "green"`, red for `health: "red"`,
gray for `health: "unknown"`.

**Acceptance criteria:**
- AC-7.2a: Given `tokens: [{project: "edit-director", tokenName: "GITHUB_TOKEN_EDIT", health: "green", expiry: "2026-12-01T00:00:00Z"}]`, the table SHALL render one row with a green dot, project name, token name, and expiry date.
- AC-7.2b: A row with `health: "red"` SHALL render the entire row highlighted (e.g., `background: rgba(248, 81, 73, 0.1)`).
- AC-7.2c: A row with `expiry: null` SHALL render `"—"` in the Expiry cell.

**FR-7.3** — The Config view SHALL display a `"Cron Schedules"` section
containing a table with columns `Name`, `Repo`, `Schedule`, `Next Fire`, and
`Status`. Data SHALL come from the `crons` array in `GET /config`. Each row
SHALL have a pause/resume toggle button that calls `POST /crons/:name/pause` or
`POST /crons/:name/resume` respectively and optimistically toggles the `paused`
state.

**Acceptance criteria:**
- AC-7.3a: Given `crons: [{name: "dpdk-cycle", repo: "gspivey/dpdk-stdlib-rust", schedule: "*/30 * * * *", nextFireTime: "2026-10-11T03:00:00Z", paused: false}]`, the table SHALL render one row.
- AC-7.3b: For an active cron (`paused: false`), the toggle button SHALL read `"Pause"` and call `POST /crons/dpdk-cycle/pause` on click.
- AC-7.3c: For a paused cron (`paused: true`), the toggle button SHALL read `"Resume"` and call `POST /crons/dpdk-cycle/resume` on click.
- AC-7.3d: On API error from pause/resume, the optimistic toggle SHALL be reverted and an inline error SHALL be shown.
- AC-7.3e: `nextFireTime: null` SHALL render as `"—"` in the Next Fire cell.

**FR-7.4** — The Config view SHALL display a `"Session Timeouts"` card showing:
- Inactivity timeout (minutes)
- Max lifetime (minutes)
- Grace period after merge (seconds)

Data SHALL come from `sessionTimeouts` in `GET /config`. This card is
display-only.

**Acceptance criteria:**
- AC-7.4a: Given `sessionTimeouts: { inactivityMinutes: 60, maxLifetimeMinutes: 1440, gracePeriodAfterMergeSeconds: 30 }`, all three values SHALL be rendered.

**FR-7.5** — The Config view SHALL display a `"Rate Limits"` card showing
per-PR interval in seconds. Data SHALL come from `rateLimits.perPRSeconds` in
`GET /config`. This card is display-only.

**Acceptance criteria:**
- AC-7.5a: Given `rateLimits: { perPRSeconds: 300 }`, the card SHALL display `"300 s"` or equivalent.

**FR-7.6** — The Config view SHALL display a `"Repositories"` section containing
a table with columns `Owner/Repo` and `Webhook Configured`. Data SHALL come
from the `repos` array in `GET /config`. The table SHALL NOT show secret values.
A repo where `webhookSecretName === '[configured]'` (the exact backend sentinel
string) SHALL show `"yes"` (green indicator); otherwise show `"no"` (amber
indicator).

**Acceptance criteria:**
- AC-7.6a: Given `repos: [{name: "gspivey/agent-router", webhookSecretName: "[configured]"}]`, the row SHALL show a green indicator.
- AC-7.6b: Given `webhookSecretName: "WEBHOOK_SECRET_gspivey_agent-router"` (not exactly `"[configured]"`), the row SHALL show an amber indicator.
- AC-7.6c: No secret values SHALL be rendered.

**FR-7.7** — The Config view tables SHALL be readable on mobile (≤768 px) with
horizontal scroll enabled on overflow, not wrapping columns in a way that breaks
the table structure.

**Acceptance criteria:**
- AC-7.7a: The Token Health, Cron Schedules, and Repositories tables SHALL each be wrapped in a container with `overflow-x: auto`.

---

## Non-Functional Requirements

**NFR-1: API client scope** — All new API endpoints (`GET /repos/sessions`,
`GET /repos/:repo/sessions`, `POST /crons/:name/pause`,
`POST /crons/:name/resume`, `POST /sessions/:id/kill`, `GET /config`) SHALL be
added to `client/src/lib/api.ts` with typed request/response shapes defined in
`client/src/lib/types.ts`.

**NFR-2: No regressions** — The existing SPA capabilities (skeleton loaders,
streaming cursor, reconnect pill, session-ended pill, `Interrupt` action,
inject/prompt, SSE replay, mobile layout) SHALL remain fully functional after
this spec is implemented. No existing test SHALL be removed; existing tests SHALL
remain passing.

**NFR-3: Svelte 5 runes API** — All new components SHALL use the Svelte 5 runes
API (`$state`, `$derived`, `$props`) and SHALL NOT use Svelte 4 lifecycle APIs
(`createEventDispatcher`, reactive declarations with `$:`).

**NFR-4: TypeScript strictness** — All new TypeScript SHALL compile without
errors under the existing `tsconfig.json` settings. No `any` casts shall be
introduced unless bridging an intentionally untyped external boundary.

**NFR-5: Accessibility** — Interactive elements (Kill button, confirmation
dialog, toggle buttons) SHALL have accessible labels (`aria-label` or visible
text). The confirmation dialog SHALL trap focus while open.

**NFR-6: Test coverage** — Each new component and API function SHALL have unit
tests using the existing vitest + `@testing-library/svelte` setup. The following
test cases SHALL be present:
- `SessionCard` tests for PR links, short ID, termination reason, duration.
- `RepoGroup` tests for header rendering, collapse/expand, auto-collapse logic.
- `ToolCallCard` tests for truncation at >20 lines and expand button.
- `api.ts` tests for all new endpoint functions.
- `ConfigView` tests for table rendering and cron toggle action.
- `ChatView` / `buildRenderItems` tests for internals toggle: filter on/off, `ar-show-internals` localStorage persistence, and `rawSource` passthrough from `buildRenderItems`.

**NFR-7: localStorage keys** — All localStorage keys SHALL use the `"ar-"`
prefix to avoid collisions: `"ar-repo-collapsed-<repo>"`, `"ar-show-internals"`.

**NFR-8: Mobile usability** — Session list and detail views SHALL remain
mobile-first (320 px). Config view tables require only horizontal scrollability;
full mobile optimization is not required.
