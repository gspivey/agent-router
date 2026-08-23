# Design: Web UI Configuration View

## Architecture Overview

The Config tab follows the same architectural pattern as the existing Sessions tab:

```
Browser (SPA)  ──GET /api/config──►  web-routes.ts  ──►  config.ts (read config)
                                                     ──►  token-store.ts (token health)
```

- **Frontend**: New `#config` hash route in the existing SPA template (`src/web-ui.ts`), rendered by the same `renderWebUI()` function.
- **Backend**: New REST endpoint(s) in `src/web-routes.ts`, behind the existing auth middleware.
- **Data sources**: `src/config.ts` for config values; `src/token-store.ts` for token health/expiry metadata.

## API Design

### `GET /api/config`

Returns the full read-only config view payload. Authenticated via existing daemon-token/trusted-proxy middleware.

**Response (200):**

```json
{
  "sessionTimeouts": {
    "inactivityMinutes": 30,
    "maxLifetimeMinutes": 180,
    "gracePeriodAfterMergeSeconds": 300
  },
  "rateLimits": {
    "perPRSeconds": 60
  },
  "crons": [
    {
      "name": "nightly-review",
      "repo": "gspivey/agent-router",
      "schedule": "0 3 * * *",
      "nextFireTime": "2026-08-24T03:00:00.000Z",
      "paused": false
    }
  ],
  "tokens": [
    {
      "project": "gspivey/agent-router",
      "tokenName": "GITHUB_TOKEN_agent_router",
      "isSet": true,
      "expiry": "2027-01-15T00:00:00.000Z",
      "health": "green"
    }
  ],
  "repos": [
    {
      "name": "gspivey/agent-router",
      "webhookSecretName": "WEBHOOK_SECRET_agent_router"
    }
  ]
}
```

**Field details:**

| Field | Source | Notes |
|-------|--------|-------|
| `sessionTimeouts.*` | `config.reaper` | Direct pass-through of reaper config values |
| `rateLimits.perPRSeconds` | `config.rateLimits.perPRSeconds` | Direct pass-through |
| `crons[].nextFireTime` | Computed from cron expression | ISO 8601, client renders in local time |
| `crons[].paused` | Runtime cron state | From cron manager's pause map |
| `tokens[].health` | Derived | `"green"` if set + not expired, `"red"` if missing/expired, `"unknown"` if expiry can't be determined |
| `tokens[].expiry` | `token-store.ts` | ISO 8601 or `null` if unknown |
| `repos[].webhookSecretName` | Derived from repo config | Environment variable name pattern, never the value |

**Error response (500):**

```json
{
  "error": "Failed to load configuration"
}
```

## Frontend Design

### Navigation

The existing nav structure in `web-ui.ts` uses `<a>` tags with hash hrefs. A new nav item is appended:

```html
<a href="#sessions" class="nav-link active">Sessions</a>
<a href="#config" class="nav-link">Config</a>
```

Active state toggling follows the existing `hashchange` event listener pattern.

### Page Layout

The Config page uses a card-based layout with sections, matching the Sessions detail view style:

```
┌─────────────────────────────────────────────────────┐
│  Session Timeouts          │  Rate Limits            │
│  ─────────────────         │  ──────────────         │
│  Inactivity: 30 min       │  Per-PR: 60s            │
│  Max lifetime: 180 min    │                         │
│  Grace after merge: 300s  │                         │
├─────────────────────────────────────────────────────┤
│  Cron Schedules                                     │
│  ───────────────                                    │
│  Name          Repo              Schedule   Next    │
│  nightly-rev   gspivey/agent-r   0 3 * * * Sun ... │
│  ...           (paused badge)                       │
├─────────────────────────────────────────────────────┤
│  Token Health                                       │
│  ────────────                                       │
│  Project              Token Name         Status     │
│  gspivey/agent-r      GITHUB_TOKEN_...   ● Green   │
│  other/repo           OTHER_TOKEN        ● Red     │
├─────────────────────────────────────────────────────┤
│  Repositories                                       │
│  ────────────                                       │
│  Name                 Webhook Secret Name           │
│  gspivey/agent-r      WEBHOOK_SECRET_agent_router   │
└─────────────────────────────────────────────────────┘
```

### CSS Classes (reused from existing UI)

- `.card` — section container with border-radius and shadow
- `.card-header` — section title
- `.table` — data tables within cards
- `.badge` — status indicators (paused/active, green/red/unknown)
- `.status-dot` — colored circle indicator for token health

New classes (minimal additions):

- `.config-grid` — CSS grid for the top row of small cards (timeouts + rate limits side by side)
- `.health-green`, `.health-red`, `.health-unknown` — colored dot variants for token status

### Client-Side Logic

```javascript
async function loadConfig() {
  const res = await fetch('/api/config', {
    headers: { 'Authorization': `Bearer ${window.__TOKEN__}` }
  });
  if (!res.ok) throw new Error('Failed to load config');
  return res.json();
}

function renderConfigView(data) {
  // Build DOM for each section, insert into #config-container
  // Format nextFireTime using Intl.DateTimeFormat for local timezone
}

function formatNextFire(isoString) {
  if (!isoString) return 'N/A';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short', year: 'numeric', month: 'short',
    day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(isoString));
}
```

### Hash Router Integration

The existing `window.addEventListener('hashchange', ...)` handler is extended with a `#config` case:

```javascript
case '#config':
  showView('config');
  loadConfig().then(renderConfigView).catch(showError);
  break;
```

## Backend Implementation

### Route Handler (`src/web-routes.ts`)

```typescript
app.get('/api/config', async (c) => {
  try {
    const config = getConfig();
    const tokenHealth = getTokenHealthSummary();
    const cronState = getCronScheduleState();

    return c.json({
      sessionTimeouts: {
        inactivityMinutes: config.reaper.inactivityMinutes,
        maxLifetimeMinutes: config.reaper.maxLifetimeMinutes,
        gracePeriodAfterMergeSeconds: config.reaper.gracePeriodAfterMergeSeconds,
      },
      rateLimits: {
        perPRSeconds: config.rateLimits?.perPRSeconds ?? null,
      },
      crons: cronState,
      tokens: tokenHealth,
      repos: config.repos.map(r => ({
        name: r.name,
        webhookSecretName: r.webhookSecretEnvVar ?? `WEBHOOK_SECRET_${r.name.replace(/\//g, '_')}`,
      })),
    });
  } catch (err) {
    return c.json({ error: 'Failed to load configuration' }, 500);
  }
});
```

### Token Health Helper (`src/token-store.ts`)

A new exported function `getTokenHealthSummary()` that iterates the token map and returns:

```typescript
interface TokenHealthEntry {
  project: string;
  tokenName: string;
  isSet: boolean;
  expiry: string | null;
  health: 'green' | 'red' | 'unknown';
}
```

Health derivation logic:
- Token not in map or empty → `red`
- Token present, expiry known and past → `red`
- Token present, expiry known and future → `green`
- Token present, expiry unknown → `green` (assume valid)

**Token expiry source**: GitHub PAT expiry is NOT available from the GitHub API without a dedicated check. Expiry metadata is only available if the token store (`src/token-store.ts`) explicitly persists it at token-registration time (e.g., from a user-supplied expiry date or from a PAT's `expires_at` field recorded when the token was first validated). If `token-store.ts` does not currently track expiry, the `expiry` field MUST be `null` and health reported as `green` (present, expiry unknown). The task for `getTokenHealthSummary()` MUST verify whether `TokenEntry` in `token-store.ts` has an expiry field; if not, the function should return `expiry: null` and skip expiry-based health checks rather than inventing a check mechanism.

### Cron State Helper

A new exported function in **`src/cron-state.ts`** (new file) `getCronScheduleState()` that returns:

```typescript
interface CronScheduleEntry {
  name: string;
  repo: string;
  schedule: string;
  nextFireTime: string | null;
  paused: boolean;
}
```

Next fire time is computed from the cron expression using the existing cron library already in the project (e.g., `cron-parser` or `node-cron`).

## Security Considerations

- **No secret values**: Webhook secret values and token values are never included in the API response. Only names and metadata are exposed.
- **Auth gating**: The `/api/config` endpoint sits behind the same auth middleware as `/api/sessions`.
- **No mutation**: The endpoint is GET-only; no POST/PUT/PATCH/DELETE handlers are registered.

## Error Handling

- If config file is unreadable, return 500 with generic error message.
- If token store is unavailable, the `tokens` array returns entries with `health: "unknown"`.
- If cron next-fire computation fails for an entry, `nextFireTime` is `null` and the UI shows "N/A".

## Testing Strategy

- Unit test the `getTokenHealthSummary()` function with various token states.
- Unit test `getCronScheduleState()` with sample cron expressions.
- Integration test: `GET /api/config` returns expected shape with mock config.
- Manual verification: Config tab renders correctly with real daemon config.
