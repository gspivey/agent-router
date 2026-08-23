# Requirements: Web UI Sessions Grouped by Repo

## Overview
Restructure the agent-router web UI session list from a flat chronological list to a grouped-by-repo layout. Each configured repo gets its own section with active sessions pinned, recent terminal sessions listed, cron state displayed, and open PR counts shown.

## Functional Requirements

### FR-1: Repo Section Layout
- Each repo configured in `config.repos[]` MUST have its own visual section on the list view.
- Section header displays the repo full name (`owner/name`).
- Repos with no sessions ever are still shown (they exist in config).

### FR-2: Active Session Pinning
- If a repo has an active session, it MUST appear at the top of that repo's section.
- Active sessions display a live streaming indicator (pulsing dot or similar).
- The existing `waiting_for` state is shown inline on active sessions.

### FR-3: Terminal Sessions (Completed/Failed/Abandoned)
- Below the active session (if any), the last N terminal sessions are listed (default N=5).
- Terminal sessions are collapsible — sections with no recent activity (no active session and all terminal sessions older than 24h) start collapsed.
- A "Show more" control loads additional terminal sessions for that repo (per-repo pagination).

### FR-4: Cron State Display
- Each repo section shows the current cron pause state for cron jobs targeting that repo.
- If paused, show "Cron paused" indicator.
- Show the cron schedule expression (human-friendly if feasible, raw otherwise) and next expected fire time.
- If no cron job targets this repo, omit the cron line.

### FR-5: Open PR Count
- Each repo section header shows a count of open (unmerged) PRs associated with sessions for that repo.
- PR count links to the repo's PR listing on GitHub when clicked.

### FR-6: Session Detail View Preserved
- Clicking any session item navigates to the existing detail view (`#/sessions/:id`).
- Detail view functionality (SSE streaming, inject/stop/kill controls) is unchanged.
- Back button returns to the grouped list view.

### FR-7: Pagination
- Pagination is per-repo section, not global.
- Each section independently paginates its terminal sessions.
- Active sessions are never paginated (always shown).

### FR-8: Section Collapse/Expand
- Each repo section can be manually collapsed/expanded by clicking the header.
- Collapse state persists in `localStorage` across page reloads.
- Sections with no recent activity (defined: no active session AND latest terminal session >24h old) default to collapsed on initial load.

## Non-Functional Requirements

### NFR-1: Performance
- Overall page load time MUST be ≤ the existing flat list load time.
- The API should support fetching grouped data in a single round-trip where possible.

### NFR-2: No New Dependencies
- No new npm packages may be added.
- All UI changes remain in the single inline HTML/CSS/JS template approach.

### NFR-3: Auth Model Unchanged
- Existing daemon-token and trusted-proxy auth mechanisms remain untouched.
- Read/write guards apply identically.

### NFR-4: Mobile Responsiveness
- Grouped sections must render correctly on mobile viewports (existing responsive breakpoints maintained).
- Touch targets remain ≥44px.

### NFR-5: Accessibility
- Section headers are semantic (`<h2>` or equivalent).
- Collapse/expand uses `aria-expanded` and `aria-controls`.
- Live streaming indicator has an `aria-label`.

## Out of Scope
- Cross-repo operations (actions spanning multiple repos).
- Project grouping (grouping multiple repos under a project).
- Changes to the webhook server or GitHub event processing.
- Changes to the session detail view UI beyond navigation updates.
