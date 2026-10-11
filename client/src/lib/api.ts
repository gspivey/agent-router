/**
 * Typed REST client for the SPA.
 *
 * Each function attaches `Authorization: Bearer <token>` (Requirement 3.3) and
 * returns typed response data. On HTTP 401 or 403 the client clears the stored
 * token, aborts active SSE streams, enters the "Session expired" lockout
 * (Requirement 3.4), and throws `AuthError('expired')` — it does NOT retry.
 *
 * The repo-grouped session list endpoints (`GET /repos/sessions`,
 * `GET /repos/:repo/sessions`) were added by the spa-operator-restoration spec
 * (ROADMAP item 80) to restore the operator session list.
 */

import { auth, enterExpiredState } from './stores.svelte.js';
import type {
  InjectResponse,
  InterruptResponse,
  ListSessionsQuery,
  RepoPageResponse,
  RepoSessionsResponse,
  SessionDetailResponse,
  SessionListResponse,
} from './types.js';

/** Thrown when there is no token (`missing`) or the server rejected it (`expired`). */
export class AuthError extends Error {
  readonly kind: 'missing' | 'expired';
  constructor(kind: 'missing' | 'expired') {
    super(kind === 'missing' ? 'No token available' : 'Session expired');
    this.name = 'AuthError';
    this.kind = kind;
  }
}

/** Thrown for non-auth API failures (non-2xx that is not 401/403, or bad JSON). */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Issue an authenticated request. Attaches the bearer header, maps 401/403 to
 * the expired lockout, and throws `AuthError('missing')` when no token is set.
 */
async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = auth.token;
  if (token === null || token === '') {
    throw new AuthError('missing');
  }
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401 || res.status === 403) {
    enterExpiredState();
    throw new AuthError('expired');
  }
  return res;
}

/** Parse a JSON body, surfacing a non-2xx as an `ApiError`. */
async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new ApiError(res.status, `Request failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Build the `GET /sessions` query string from a typed query object. */
function buildSessionsQuery(q?: ListSessionsQuery): string {
  if (!q) return '';
  const params = new URLSearchParams();
  if (q.status !== undefined) params.set('status', q.status);
  if (q.since !== undefined) params.set('since', String(q.since));
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  if (q.offset !== undefined) params.set('offset', String(q.offset));
  if (q.repo !== undefined) params.set('repo', q.repo);
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const api = {
  /** `GET /sessions` — the session list (NFR-1.2: one request). */
  async listSessions(q?: ListSessionsQuery): Promise<SessionListResponse> {
    const res = await authedFetch(`/sessions${buildSessionsQuery(q)}`);
    return readJson<SessionListResponse>(res);
  },

  /**
   * `GET /sessions/:id?lines=<n>` — detail + history, including the additive
   * `first_event_id` / `last_event_id` seam fields (Requirement 10).
   */
  async getSession(id: string, lines = 200): Promise<SessionDetailResponse> {
    const res = await authedFetch(`/sessions/${encodeURIComponent(id)}?lines=${lines}`);
    return readJson<SessionDetailResponse>(res);
  },

  /** `POST /sessions/:id/inject` — enqueue a prompt (HTTP 202). */
  async inject(id: string, prompt: string): Promise<InjectResponse> {
    const res = await authedFetch(`/sessions/${encodeURIComponent(id)}/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    return readJson<InjectResponse>(res);
  },

  /** `POST /sessions/:id/interrupt` — interrupt the current agent turn (HTTP 200). */
  async interrupt(id: string): Promise<InterruptResponse> {
    const res = await authedFetch(`/sessions/${encodeURIComponent(id)}/interrupt`, {
      method: 'POST',
    });
    return readJson<InterruptResponse>(res);
  },

  /** `GET /repos/sessions` — sessions grouped by repo (spa-operator-restoration A-2). */
  async listRepoSessions(): Promise<RepoSessionsResponse> {
    const res = await authedFetch('/repos/sessions');
    return readJson<RepoSessionsResponse>(res);
  },

  /**
   * `GET /repos/:repo/sessions?limit=N&offset=N` — a page of terminal sessions
   * for a single repo (spa-operator-restoration A-2).
   */
  async listRepoPagedSessions(
    repo: string,
    limit: number,
    offset: number,
  ): Promise<RepoPageResponse> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const res = await authedFetch(`/repos/${encodeURIComponent(repo)}/sessions?${params}`);
    return readJson<RepoPageResponse>(res);
  },
};
