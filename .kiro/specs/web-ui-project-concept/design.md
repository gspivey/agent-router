# Design: Web UI Project Concept (Multi-Repo Grouping)

## Architecture Overview

The feature adds a thin "project" layer on top of existing repo/session infrastructure. It introduces:

1. **Config extension** — new `projects` field in `AgentRouterConfig`
2. **Project module** — pure functions for health computation and token validation
3. **API endpoint** — `GET /projects` in web-routes
4. **UI panel** — project sections rendered above the session list

```
config.json
    │
    ▼
┌──────────┐      ┌──────────────┐      ┌───────────┐
│ config.ts│─────▶│ projects.ts  │◀─────│web-routes │
│ (parse)  │      │ (logic)      │      │ (API)     │
└──────────┘      └──────────────┘      └───────────┘
                         │                     │
                         ▼                     ▼
                  ┌──────────────┐      ┌───────────┐
                  │session-files │      │ web-ui.ts │
                  │(session data)│      │ (render)  │
                  └──────────────┘      └───────────┘
```

## Data Model

### Config Schema Addition

```typescript
// src/config.ts — new types

export interface ProjectConfig {
  name: string;
  repos: string[]; // full names: "owner/name"
}

// Added to AgentRouterConfig:
export interface AgentRouterConfig {
  // ... existing fields ...
  /** Optional project groupings for multi-repo visibility. */
  projects?: ProjectConfig[];
}
```

### API Response Shape

```typescript
// GET /projects response

interface ProjectHealth {
  status: 'green' | 'partial' | 'paused';
  activeSessions: number;
  failedSessions: number;
}

interface RepoStatus {
  fullName: string;       // "owner/name"
  activeSessions: number;
  hasToken: boolean;      // whether token coverage exists
}

interface ProjectResponse {
  name: string;
  health: ProjectHealth;
  tokenCoverage: {
    complete: boolean;
    missingRepos: string[];  // repos without token config
  };
  repos: RepoStatus[];
}

interface ProjectsAPIResponse {
  projects: ProjectResponse[];
  ungrouped: RepoStatus[];
}
```

## Module Design

### `src/projects.ts` — Pure Logic Module

This module contains no I/O. All functions are pure and testable.

```typescript
export interface ProjectConfig {
  name: string;
  repos: string[];
}

export type ProjectHealthStatus = 'green' | 'partial' | 'paused';

export interface ComputedProjectHealth {
  status: ProjectHealthStatus;
  activeSessions: number;
  failedSessions: number;
}

export interface TokenCoverage {
  complete: boolean;
  missingRepos: string[];
}

/**
 * Compute health for a project given per-repo session counts.
 * lastSessionAt: most recent session created_at across all project repos (null if no sessions ever)
 */
export function computeProjectHealth(
  repoSessionCounts: Map<string, { active: number; failed: number; lastSessionAt: Date | null }>,
  projectRepos: string[],
): ComputedProjectHealth;

/**
 * Check token coverage: a repo is covered if it has a per-repo token
 * or a defaultGithubToken is configured.
 */
export function computeTokenCoverage(
  projectRepos: string[],
  repoConfigs: Array<{ fullName: string; hasToken: boolean }>,
  hasDefaultToken: boolean,
): TokenCoverage;

/**
 * Partition repos into project-assigned and ungrouped.
 */
export function partitionRepos(
  allRepos: string[],
  projects: ProjectConfig[],
): { assigned: Set<string>; ungrouped: string[] };

/**
 * Validate project config: unique names, no duplicate repo assignments,
 * repos reference known configured repos.
 */
export function validateProjects(
  projects: ProjectConfig[],
  knownRepos: string[],
): { valid: true } | { valid: false; errors: string[] };
```

### Health Status Logic

| Condition | Status |
|-----------|--------|
| All repos have 0 failed/abandoned active sessions | `green` |
| At least one repo has a failed/abandoned session, others healthy | `partial` |
| All repos have 0 active sessions AND no session was created within the last 24h | `paused` |
| A repo has never had a session (no session history) | contributes to `green` (no failures) |

**Health for never-sessioned repos**: A repo with zero session history contributes no failures and no active sessions. It is treated as healthy-inactive — it does not block a `green` or `paused` aggregate, and does not trigger `partial`.

**Badge colors**: `green` → `.badge-green`, `partial` → `.badge-yellow`, `paused` → `.badge-paused` (new class, renders gray, distinguishable from green/yellow/red).

### Token Coverage Logic

A repo is "covered" if:
- It has a `token` field in its `RepoConfig`, OR
- The global `defaultGithubToken` is set

Missing coverage is informational — flagged but not blocking.

## API Design

### `GET /projects`

**Auth**: Same as `/sessions` (daemon token or trusted proxy).

**Response** (200):
```json
{
  "projects": [
    {
      "name": "Core Infrastructure",
      "health": { "status": "green", "activeSessions": 2, "failedSessions": 0 },
      "tokenCoverage": { "complete": true, "missingRepos": [] },
      "repos": [
        { "fullName": "gspivey/agent-router", "activeSessions": 1, "hasToken": true },
        { "fullName": "gspivey/libby-mcp", "activeSessions": 1, "hasToken": true }
      ]
    }
  ],
  "ungrouped": [
    { "fullName": "gspivey/other-repo", "activeSessions": 0, "hasToken": false }
  ]
}
```

### `GET /sessions?repo=<owner/name>` (extended)

Adds an optional `repo` query parameter to the existing `/sessions` endpoint. When provided, only sessions where `meta.repo === repo` are returned. The `repo` value must contain `/` (basic validation). This supports the UI repo-filter interaction from the projects panel.

## UI Design

### Layout Change

The list view (`#list-view`) gains a project panel above the session list:

```
┌─────────────────────────────────────┐
│ [Projects Panel]                     │
│  ┌─ Core Infrastructure [●green] ──┐│
│  │  agent-router (1 active)        ││
│  │  libby-mcp (1 active)           ││
│  └──────────────────────────────────┘│
│  ┌─ Ungrouped ─────────────────────┐│
│  │  other-repo (0 active)          ││
│  └──────────────────────────────────┘│
├─────────────────────────────────────┤
│ [Session List - existing]            │
│  ...                                 │
└─────────────────────────────────────┘
```

### UI Behavior

- Project sections are collapsible (default: expanded).
- Health badge uses existing `.badge-green`, `.badge-yellow`, `.badge-red` classes.
- Token warning uses a small icon/text next to the project name.
- Clicking a repo name sets a filter on the session list (`?repo=owner/name` query param or client-side filter).
- If no projects are configured, the panel is hidden entirely (backward compatible).

### New CSS Classes

```css
.projects-panel { margin-bottom: 16px; }
.project-section { border: 1px solid #30363d; border-radius: 8px; margin-bottom: 8px; background: #0d1117; }
.project-header { padding: 12px; display: flex; align-items: center; gap: 8px; cursor: pointer; }
.project-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
.project-repos { padding: 0 12px 12px; }
.project-repo-item { padding: 4px 0; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.token-warning { font-size: 11px; color: #d29922; }
```

### Accessibility

- Project sections use `<section role="region" aria-labelledby="project-{name}">`.
- Collapse/expand uses `aria-expanded` on the header button.
- Health badges include `aria-label` with full text (e.g., "Health: all repos healthy").

## Config Validation Changes

In `validateConfig()` (src/config.ts), add after existing repo validation:

1. If `projects` key exists, validate it's an array.
2. Each project must have non-empty `name` and non-empty `repos` array.
3. Project names must be unique (case-insensitive comparison).
4. Each repo string in projects must match a configured repo (`owner/name` format from `repos[]`).
5. A repo cannot appear in more than one project.

Validation errors throw `FatalError` with descriptive messages, consistent with existing validation style.

## Integration Points

| Component | Change |
|-----------|--------|
| `src/config.ts` | Add `ProjectConfig` interface, `projects?` field, validation logic |
| `src/projects.ts` | New module: health computation, token coverage, partitioning |
| `src/web-routes.ts` | Add `GET /projects` route handler |
| `src/web-server.ts` | Mount `/projects` under auth middleware |
| `src/web-ui.ts` | Add projects panel HTML/CSS/JS to the template |

## Error Handling

- If `/projects` endpoint fails, the UI shows the session list without the projects panel (graceful degradation).
- Config validation errors at startup are fatal (consistent with existing behavior).
- Invalid repo references in project config produce clear error messages listing the unrecognized repo names.

## Testing Strategy

- **Unit tests** for `src/projects.ts`: health computation, token coverage, validation edge cases.
- **Integration tests** for `GET /projects`: mock session data, verify response shape.
- **Config validation tests**: projects with duplicate names, unknown repos, duplicate repo assignments.
- **UI tests**: verify panel renders when projects exist, hidden when absent, filter interaction works.
