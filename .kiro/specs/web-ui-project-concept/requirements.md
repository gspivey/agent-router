# Requirements: Web UI Project Concept (Multi-Repo Grouping)

## Overview

Add a "project" concept to agent-router: a named group of repos that share a common goal and can be viewed as a unit in the web UI. This is read-only grouping defined in config — no dynamic creation or multi-repo operations.

## Functional Requirements

### FR-1: Project Definition in Config

- **FR-1.1**: Support an optional `projects` array in config.json at the top level of `AgentRouterConfig`.
- **FR-1.2**: Each project has a `name` (string, unique, non-empty) and a `repos` array of repo full names (e.g., `"gspivey/agent-router"`).
- **FR-1.3**: A repo SHALL belong to exactly zero or one project. If a repo appears in multiple projects, config validation fails with a clear error.
- **FR-1.4**: Repos not assigned to any project are implicitly in an "Ungrouped" section.
- **FR-1.5**: The `projects` key is optional. Existing configs without it continue to work unchanged (backward compatible).

### FR-2: Project Health Aggregation

- **FR-2.1**: Each project displays an aggregate health badge derived from the status of its repos' active sessions.
- **FR-2.2**: Health states:
  - **All Green**: All repos in the project have zero active sessions, or all active sessions have status:active (none failed or abandoned).
  - **Partial**: At least one repo has a failed or abandoned session while others are healthy.
  - **All Paused**: All repos in the project have no active sessions AND no session was created within the last 24 hours across the project.
- **FR-2.3**: Health is computed server-side and served via API to avoid client-side aggregation complexity.

### FR-3: Token Scope Validation

- **FR-3.1**: For each project, validate whether the configured GitHub token(s) cover all repos in the group.
- **FR-3.2**: A repo is "covered" if it has either a per-repo `token` override or falls back to the `defaultGithubToken`.
- **FR-3.3**: Display a warning badge on projects where any repo lacks token coverage.
- **FR-3.4**: Token scope gaps are informational only — they do not block operation.

### FR-4: Web UI Display

- **FR-4.1**: Projects appear as collapsible top-level sections in the web UI, above the session list.
- **FR-4.2**: Each project section shows: project name, health badge, repo count, and list of repos with their individual status.
- **FR-4.3**: Token scope warnings appear inline within the project section header.
- **FR-4.4**: An "Ungrouped" section lists repos not assigned to any project (only shown if ungrouped repos exist).
- **FR-4.5**: Clicking a repo within a project filters the session list to show only sessions for that repo.
- **FR-4.6**: The existing session list view remains the primary view; projects are a supplementary navigation/status panel.

### FR-5: API Endpoint

- **FR-5.1**: Add a `GET /projects` endpoint that returns project definitions with computed health and token coverage status.
- **FR-5.2**: The endpoint requires the same authentication as other web control plane routes.
- **FR-5.3**: Response includes ungrouped repos as a separate entry.

## Non-Functional Requirements

### NFR-1: Backward Compatibility

- Existing configs without `projects` must load without error.
- The web UI must degrade gracefully: if no projects are defined, the UI behaves exactly as before.

### NFR-2: Performance

- Health computation should not add significant latency to page load. Session scanning is already done for the list view; reuse that data.

### NFR-3: Accessibility

- Project sections must be keyboard-navigable and use proper ARIA roles (region, heading levels).
- Health badges must have accessible text alternatives (not color-only).

### NFR-4: Maintainability

- Project logic should be isolated in its own module(s) rather than mixed into existing session code.

## Out of Scope

- Coordinated multi-repo operations (future phase)
- Dynamic project creation/editing via UI
- Cross-project dependency tracking
- Per-repo health beyond session status (e.g., CI status, deploy health)
