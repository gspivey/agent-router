# Requirements: Web UI Configuration View

## Overview

Add a read-only "Config" tab to the agent-router web UI (ar-web.gspivey.com) that surfaces the daemon's current runtime configuration, token health, and cron schedule state. Users should be able to inspect system settings without SSH-ing into the server or reading raw JSON files.

## Functional Requirements

### FR-1: Config Tab Navigation
- **FR-1.1**: A "Config" tab appears in the top navigation bar alongside the existing "Sessions" tab.
- **FR-1.2**: The tab uses hash-based routing (`#config`) consistent with the existing SPA navigation pattern.
- **FR-1.3**: Clicking the tab loads config data without a full page reload.

### FR-2: Session Timeout Settings Display
- **FR-2.1**: Display `inactivityMinutes` — the idle timeout before a session is reaped.
- **FR-2.2**: Display `maxLifetimeMinutes` — the session lifetime upper bound (in minutes).
- **FR-2.3**: Display `gracePeriodAfterMergeSeconds` — the delay before reaping a session after its PR merges.

### FR-3: Rate Limit Settings Display
- **FR-3.1**: Display `perPRSeconds` — the lower-bound interval between processing events for the same PR.

### FR-4: Cron Schedules Display
- **FR-4.1**: Display each configured cron job with: name, target repo, cron expression.
- **FR-4.2**: Show the next fire time in the user's local timezone in a human-readable format (e.g., "Sun Aug 23, 2026 at 3:00 PM").
- **FR-4.3**: Show the current pause state of each cron job (paused / active).

### FR-5: Token Health Display
- **FR-5.1**: For each configured repo/project, display the associated token name.
- **FR-5.2**: Show a green/red/unknown health indicator per token:
  - **Green**: Token is set and not expired (or expiry unknown but token present).
  - **Red**: Token is missing, empty, or known to be expired.
  - **Unknown**: Token presence cannot be determined.
- **FR-5.3**: Display token expiry date if known.

### FR-6: Repository List Display
- **FR-6.1**: List all configured repositories.
- **FR-6.2**: For each repo, show the webhook secret name (e.g., `WEBHOOK_SECRET_myrepo`) — name only, never the value.

## Non-Functional Requirements

### NFR-1: Read-Only
- The Config tab provides no editing, mutation, or write-back capabilities.

### NFR-2: Design Consistency
- Uses the same CSS classes, color palette, typography, and layout patterns as the existing Sessions tab.
- Uses the same auth model (daemon-token bearer auth or trusted-proxy header).

### NFR-3: No New Dependencies
- No new npm packages are introduced. Implementation uses only what is already in the project.

### NFR-4: Performance
- Config data loads in 1 or 2 API calls (config plus optional token status).
- Page renders within 200ms of receiving API response on a typical connection.

### NFR-5: Security
- Webhook secret values are never transmitted to the client — only names/presence.
- Token values are never transmitted to the client — only names, presence, and expiry metadata.
- All endpoints require the same authentication as existing web-routes.

## Out of Scope
- Editing or saving configuration changes.
- Managing cron pause/resume state (separate feature).
- Token rotation or creation.
- Historical config change tracking.
