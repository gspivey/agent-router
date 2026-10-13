/**
 * Client-OWNED DTOs for the SPA.
 *
 * These mirror the backend response shapes (`src/web-routes.ts`,
 * `src/session-files.ts`) by VALUE — the client never imports types from
 * `../src/`. The only cross-directory import allowed is the `@shared/logic`
 * alias (pure logic), per the design "Shared logic" section (HIGH-8, NFR-2.2).
 *
 * Keep these in sync with the backend field names exactly; a mismatch is a bug.
 */

/** Closed status union, mirrors `SessionMeta['status']`. */
export type SessionStatus = 'active' | 'completed' | 'abandoned' | 'failed';

/** A registered PR on a session, mirrors `SessionMeta['prs'][number]`. */
export interface SessionPr {
  repo: string;
  pr_number: number;
  registered_at: number;
  /** Set when the auto-completion path records a merge. Optional. */
  merged_at?: number;
}

/**
 * A session row as returned by `GET /sessions`, mirrors `SessionSummary` from
 * `src/web-routes.ts`.
 */
export interface SessionSummary {
  session_id: string;
  repo: string | null;
  status: SessionStatus;
  /** Unix seconds. */
  created_at: number;
  completed_at: number | null;
  termination_reason: string | null;
  prs: SessionPr[];
  waiting_for: string | null;
}

/**
 * The `GET /sessions` paginated envelope, mirrors `PaginatedResult` from
 * `src/web-routes.ts`.
 */
export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Session metadata as embedded in the detail response, mirrors the subset of
 * `SessionMeta` the SPA reads. Extra backend fields are tolerated via the index
 * signature so a backend addition never breaks client parsing.
 */
export interface SessionMeta {
  session_id: string;
  repo?: string;
  status: SessionStatus;
  created_at: number;
  completed_at: number | null;
  termination_reason?: string;
  prs: SessionPr[];
  [key: string]: unknown;
}

/**
 * A raw `stream.log` NDJSON line. Mirrors `StreamEntry` from
 * `src/session-files.ts`; the client OWNS this type and does NOT import it from
 * `../src/`. Normalized through `parseStreamEntry` (from `@shared/logic`) before
 * rendering.
 */
export interface StreamEntry {
  ts: string;
  source: 'router' | 'agent';
  type: string;
  [key: string]: unknown;
}

/**
 * The `GET /sessions/:id?lines=200` detail response, mirrors the shape returned
 * by `tailStreamLog` + the handler in `src/web-routes.ts`.
 *
 * `first_event_id` / `last_event_id` are the SSE broker ids of the FIRST and
 * LAST valid entries in `entries` (Requirement 10.1), or `null` when `entries`
 * is empty. The SPA sends `Last-Event-ID: <last_event_id>` on its first SSE
 * connect so replay resumes exactly after this slice.
 */
export interface SessionDetailResponse {
  meta: SessionMeta;
  entries: StreamEntry[];
  skipped_lines: number;
  first_event_id: number | null;
  last_event_id: number | null;
}

/** `POST /sessions/:id/inject` success body (HTTP 202). */
export interface InjectResponse {
  accepted: true;
}

/** `POST /sessions/:id/interrupt` success body (HTTP 200). */
export interface InterruptResponse {
  ok: true;
}

/**
 * `POST /sessions/:id/kill` success body (HTTP 200). Added by the
 * spa-operator-restoration spec (ROADMAP item 81, task B-1) to let the operator
 * terminate an active agent session from the detail view.
 */
export interface KillResponse {
  ok: true;
}

/** Query parameters accepted by `GET /sessions`. */
export interface ListSessionsQuery {
  status?: SessionStatus;
  since?: number;
  limit?: number;
  offset?: number;
  repo?: string;
}

/**
 * Cron summary for a repo group header, mirrors `RepoGroupCron` from
 * `src/web-routes.ts`.
 */
export interface RepoGroupCron {
  readonly name: string;
  readonly schedule: string;
  readonly paused: boolean;
  /** ISO 8601 string, or null when the next fire time is unknown. */
  readonly next_fire: string | null;
}

/**
 * A repo-grouped section of the session list, mirrors `RepoGroup` from
 * `src/web-routes.ts`. The `repo` field is always `"owner/name"` (never null);
 * null-repo router sessions are not included in the grouped response.
 */
export interface RepoGroup {
  readonly repo: string;
  readonly active_sessions: SessionSummary[];
  readonly terminal_sessions: SessionSummary[];
  readonly terminal_total: number;
  readonly cron: RepoGroupCron | null;
  readonly open_pr_count: number;
  readonly closed_pr_count: number;
}

/** The `GET /repos/sessions` response envelope. */
export interface RepoSessionsResponse {
  readonly repos: RepoGroup[];
}

/**
 * The `GET /repos/:repo/sessions?limit=N&offset=N` paginated envelope. Mirrors
 * the `SessionListResponse` shape but returns only terminal sessions for a
 * single repo; `total` equals the repo's `terminal_total`.
 */
export interface RepoPageResponse {
  readonly sessions: SessionSummary[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

/**
 * A row in the Config view "Token Health" table, mirrors `TokenHealthEntry`
 * from `src/token-store.ts` (spa-operator-restoration ROADMAP 82, Task C-1).
 */
export interface TokenHealthEntry {
  readonly project: string;
  readonly tokenName: string;
  readonly isSet: boolean;
  /** ISO 8601 string, or null when no expiry is configured. */
  readonly expiry: string | null;
  readonly health: 'green' | 'red' | 'unknown';
}

/**
 * A row in the Config view "Cron Schedules" table, mirrors `CronScheduleEntry`
 * from `src/cron-state.ts` (spa-operator-restoration ROADMAP 82, Task C-1).
 */
export interface CronScheduleEntry {
  readonly name: string;
  readonly repo: string;
  readonly schedule: string;
  /** ISO 8601 string, or null when paused or the next fire is unknown. */
  readonly nextFireTime: string | null;
  readonly paused: boolean;
}

/**
 * The `GET /config` response shape, mirrors the body assembled by the
 * `/config` handler in `src/web-routes.ts`. Secret values are never exposed;
 * `repos[].webhookSecretName` is the sentinel `"[configured]"` when a per-repo
 * webhook secret is set (spa-operator-restoration ROADMAP 82, Task C-1).
 */
export interface ConfigResponse {
  sessionTimeouts: {
    inactivityMinutes: number;
    maxLifetimeMinutes: number;
    gracePeriodAfterMergeSeconds: number;
  };
  rateLimits: {
    perPRSeconds: number;
  };
  crons: CronScheduleEntry[];
  tokens: TokenHealthEntry[];
  repos: Array<{ name: string; webhookSecretName: string }>;
}

/**
 * `POST /crons/:name/pause` and `POST /crons/:name/resume` success body
 * (HTTP 200). Added by the spa-operator-restoration spec (ROADMAP item 82,
 * task C-1) to let the operator pause/resume a repo's cron from the Config view.
 */
export interface CronToggleResponse {
  ok: true;
}

/**
 * A recent-PR row in the `GET /overview` response, mirrors `OverviewRecentPr`
 * from `src/web-routes.ts` (spa-polish ROADMAP 87, Req 2.1).
 */
export interface OverviewRecentPr {
  readonly title: string;
  readonly repo: string;
  readonly url: string;
  readonly state: string;
  /** ISO 8601 string. */
  readonly opened_at: string;
}

/**
 * A cron-summary row in the `GET /overview` response, mirrors
 * `OverviewCronSummary` from `src/web-routes.ts` (spa-polish ROADMAP 87).
 */
export interface OverviewCronSummary {
  readonly name: string;
  readonly repo: string;
  readonly schedule: string;
  readonly state: 'active' | 'paused' | 'error';
  /** ISO 8601 string, or null when paused or unknown. */
  readonly next_fire: string | null;
}

/**
 * The `GET /overview` response shape, mirrors `OverviewResponse` from
 * `src/web-routes.ts` by value (client-owns-types). The server-side `health`
 * field is `'healthy' | 'degraded'` only; a failed fetch (crashed/unreachable
 * daemon) is surfaced as a client-only error state, not a `health` value
 * (spa-polish ROADMAP 87, Req 2).
 */
export interface OverviewResponse {
  readonly active_sessions: number;
  readonly queue_depth: number;
  readonly recent_prs: OverviewRecentPr[];
  readonly cron_summary: OverviewCronSummary[];
  readonly health: 'healthy' | 'degraded';
  readonly version: string;
  readonly uptime_s: number;
}
