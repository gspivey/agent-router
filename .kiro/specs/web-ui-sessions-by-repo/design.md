# Design: Web UI Sessions Grouped by Repo

## Architecture Overview

The change spans two layers:
1. **API layer** (`src/web-routes.ts`) — new endpoint that returns sessions pre-grouped by repo, enriched with cron state and PR counts.
2. **UI layer** (`src/web-ui.ts`) — the list view rendering logic is replaced to consume the grouped response and render repo sections.

The session detail view, SSE streaming, auth middleware, and webhook server are untouched.

## API Design

### New Endpoint: `GET /repos/sessions`

Returns all configured repos with their sessions grouped, cron state, and open PR counts in a single request.

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `per_repo_limit` | int (1-50) | 5 | Max terminal sessions per repo section |

**Response Shape:**
```json
{
  "repos": [
    {
      "repo": "owner/name",
      "active_sessions": [SessionSummary],
      "terminal_sessions": [SessionSummary],
      "terminal_total": 42,
      "cron": {
        "name": "nightly-sweep",
        "schedule": "0 3 * * *",
        "paused": false,
        "next_fire": "2026-08-24T03:00:00Z"
      } | null,
      "open_pr_count": 2
    }
  ]
}
```

**Design Rationale:**
- Single request avoids N+1 waterfalls (one per repo).
- `active_sessions` is always complete (no pagination needed — at most 1-2 active per repo).
- `terminal_sessions` is the first page; `terminal_total` enables "Show more" without a separate count call.
- Cron info is computed server-side from `config.cron[]` + `db.getCronState()`.

### New Endpoint: `GET /repos/:repo/sessions`

Per-repo terminal session pagination for "Show more" loads.

**Path Params:** `:repo` is URL-encoded `owner/name` (e.g., `gspivey%2Fagent-router`).

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | int (1-50) | 5 | Page size |
| `offset` | int (≥0) | 0 | Offset into terminal sessions for this repo |

**Response Shape:**
```json
{
  "repo": "owner/name",
  "sessions": [SessionSummary],
  "total": 42,
  "offset": 5,
  "limit": 5
}
```

### Existing Endpoint Changes

`GET /sessions` — **unchanged**. Kept for backward compatibility (CLI tools, possible external consumers). The new UI calls `GET /repos/sessions` instead.

## Server-Side Implementation

### File: `src/web-routes.ts`

New functions:

```typescript
// Groups sessions by repo using config.repos as the canonical repo list
export function groupSessionsByRepo(
  sessions: SessionMeta[],
  repos: RepoConfig[],
  cronEntries: CronConfig[],
  cronStates: CronState[],
  perRepoLimit: number,
  waitingForFn: (meta: SessionMeta) => string | undefined,
): RepoGroup[]
```

**Logic:**
1. Build a `Map<string, SessionMeta[]>` keyed by `owner/name` from all sessions.
2. For each `config.repos[]` entry, pull its sessions from the map.
3. Split into active vs terminal (sorted by `created_at` desc for terminal).
4. Slice terminal to `perRepoLimit`, record `terminal_total`.
5. Match cron entries by `entry.repo === 'owner/name'`, look up pause state from `cronStates`.
6. Compute `next_fire` from cron schedule using `node-cron`'s validation (or a simple next-occurrence calc from the cron expression — no new deps needed since `node-cron` is already present).
7. Count open PRs: PRs in `meta.prs[]` where `meta.status === 'active'` or PR not yet merged.

### Cron Next-Fire Calculation

`node-cron` doesn't expose a "next fire" API directly. We'll implement a lightweight `getNextCronFire(schedule: string): Date | null` utility that parses the 5-field cron expression and computes the next matching minute from `Date.now()`. This avoids new dependencies.

Alternative: use the `cron-parser` package — but that violates the no-new-deps constraint. The manual implementation is acceptable since we only need minute-level granularity for display purposes.

### File: `src/web-server.ts`

- Mount the new routes under the existing auth middleware (same as `/sessions`).
- Pass `config.repos`, `config.cron`, and `db` to the route factory.

## UI Design

### Layout Structure

```
┌─────────────────────────────────────────────┐
│ Agent Router                    local auth   │
├─────────────────────────────────────────────┤
│                                             │
│ ▼ gspivey/agent-router          2 PRs open  │
│   Cron: nightly-sweep · 0 3 * * * · next 3h│
│   ┌───────────────────────────────────────┐ │
│   │ ● active  gspivey/agent-router  a1b2… │ │
│   │   Created: ... · waiting: tool        │ │
│   └───────────────────────────────────────┘ │
│   ┌───────────────────────────────────────┐ │
│   │ completed  gspivey/agent-router 9f8e… │ │
│   │   Created: ... · Ended: ...           │ │
│   └───────────────────────────────────────┘ │
│   ... (up to 5)                             │
│   [Show more]                               │
│                                             │
│ ▶ other-org/other-repo            0 PRs     │
│   (collapsed — no recent activity)          │
│                                             │
└─────────────────────────────────────────────┘
```

### CSS Additions

New classes added to the existing `<style>` block:

| Class | Purpose |
|-------|---------|
| `.repo-section` | Container for each repo group |
| `.repo-header` | Clickable section header with expand/collapse |
| `.repo-header-info` | Right-aligned PR count + cron summary |
| `.repo-cron` | Cron state line below header |
| `.streaming-dot` | Pulsing green dot for active sessions |
| `.collapsed .repo-body` | Hidden when section is collapsed |
| `.show-more-btn` | "Show more" button styling |

### JS Changes

The `loadAllSessions()` function is replaced by `loadGroupedSessions()`:

1. Fetches `GET /repos/sessions`.
2. Iterates `repos[]`, rendering each as a `repo-section`.
3. Reads collapse state from `localStorage` key `repo-collapsed:<owner/name>`.
4. For sections not explicitly toggled by user, applies auto-collapse rule (no active + most recent terminal >24h old).
5. Attaches click handlers on `.repo-header` for toggle.
6. Attaches click handlers on `.show-more-btn` to call `GET /repos/:repo/sessions?offset=...&limit=5` and append results.

### Hash Routing

- `#/` → grouped list view (calls `loadGroupedSessions()`).
- `#/sessions/:id` → detail view (unchanged).
- No new hash routes needed.

### Streaming Indicator

Active sessions get a CSS-animated pulsing dot:

```css
.streaming-dot {
  display: inline-block;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #3fb950;
  animation: pulse 1.5s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

With `aria-label="Active session streaming"` for accessibility.

## Data Flow

```
Browser                    Web Server                 SessionFiles / DB
  │                            │                            │
  │ GET /repos/sessions        │                            │
  │ ──────────────────────────>│                            │
  │                            │ listSessions()             │
  │                            │ ──────────────────────────>│
  │                            │ getAllCronStates()          │
  │                            │ ──────────────────────────>│
  │                            │<──────────────────────────│
  │                            │ groupSessionsByRepo()      │
  │<──────────────────────────│                            │
  │                            │                            │
  │ (user clicks "Show more") │                            │
  │ GET /repos/:repo/sessions  │                            │
  │   ?offset=5&limit=5        │                            │
  │ ──────────────────────────>│                            │
  │                            │ filter by repo + paginate  │
  │<──────────────────────────│                            │
```

## Testing Strategy

- **Unit tests** for `groupSessionsByRepo()` — verify grouping, sorting, cron enrichment, PR counting.
- **Unit tests** for `getNextCronFire()` — verify next-fire calculation for various cron expressions.
- **Integration test** for `GET /repos/sessions` — verify response shape, auth enforcement, parameter validation.
- **Manual verification** — page load time comparison (before/after), mobile viewport check, collapse persistence.

## Migration / Backward Compatibility

- `GET /sessions` remains functional and unchanged.
- The UI switch is atomic — the template renders the new grouped view. No feature flag needed since this is a control-plane UI with a single operator audience.
- If config has zero repos (edge case during setup), the UI shows an empty state: "No repos configured."

## Files Modified

| File | Change |
|------|--------|
| `src/web-routes.ts` | Add `GET /repos/sessions`, `GET /repos/:repo/sessions`, helper functions |
| `src/web-server.ts` | Pass `config`, `db` to route factory; mount new routes under auth |
| `src/web-ui.ts` | Replace list-view rendering with grouped sections, add CSS, update JS |
| `src/cron-next.ts` | New file: `getNextCronFire(schedule)` utility |
