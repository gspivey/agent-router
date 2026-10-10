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

/** Query parameters accepted by `GET /sessions`. */
export interface ListSessionsQuery {
  status?: SessionStatus;
  since?: number;
  limit?: number;
  offset?: number;
  repo?: string;
}
