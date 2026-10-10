import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';
import type { SessionListResponse, SessionSummary } from '../lib/types.js';

/**
 * SessionList unit tests (spa-overhaul Task 4 / ROADMAP 74).
 *
 * The list is populated from a SINGLE stubbed `api.listSessions` call
 * (NFR-1.2). We assert: the list renders a row per session, the one-request
 * invariant holds, and NO Repos/Config element appears anywhere in the DOM
 * (Req 5.8). `api` is mocked so there is no live network.
 */

const listSessions = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: { listSessions: (...args: unknown[]) => listSessions(...args) },
  // Re-create the AuthError shape the component checks with `instanceof`.
  AuthError: class AuthError extends Error {
    kind: 'missing' | 'expired';
    constructor(kind: 'missing' | 'expired') {
      super(kind);
      this.name = 'AuthError';
      this.kind = kind;
    }
  },
}));

// Imported AFTER the mock is registered.
const { default: SessionList } = await import('./SessionList.svelte');
const { sessionList } = await import('../lib/stores.svelte.js');

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 'sess-1',
    repo: 'test-org/test-repo',
    status: 'active',
    created_at: 1_700_000_000,
    completed_at: null,
    termination_reason: null,
    prs: [],
    waiting_for: null,
    ...overrides,
  };
}

function response(sessions: SessionSummary[]): SessionListResponse {
  return { sessions, total: sessions.length, offset: 0, limit: 50 };
}

describe('SessionList', () => {
  beforeEach(() => {
    listSessions.mockReset();
    sessionList.loading = false;
    sessionList.items = [];
    sessionList.total = 0;
    sessionList.error = null;
    history.replaceState({}, '', '/app');
    location.hash = '';
  });

  afterEach(cleanup);

  it('renders one card per session from a single listSessions call (NFR-1.2)', async () => {
    listSessions.mockResolvedValue(
      response([
        makeSession({ session_id: 'a', repo: 'org/one' }),
        makeSession({ session_id: 'b', repo: 'org/two', status: 'completed' }),
      ]),
    );

    const { findAllByTestId } = render(SessionList);
    const cards = await findAllByTestId('session-card');
    expect(cards).toHaveLength(2);
    // Exactly ONE request issued on load.
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('renders the empty state when there are no sessions', async () => {
    listSessions.mockResolvedValue(response([]));
    const { findByTestId } = render(SessionList);
    expect(await findByTestId('list-empty')).toBeTruthy();
  });

  it('renders a retriable error state on a non-auth failure', async () => {
    listSessions.mockRejectedValue(new Error('network down'));
    const { findByTestId } = render(SessionList);
    expect(await findByTestId('list-error')).toBeTruthy();
    expect(await findByTestId('list-retry')).toBeTruthy();
  });

  it('renders NO Repos or Config navigation anywhere in the DOM (Req 5.8)', async () => {
    listSessions.mockResolvedValue(response([makeSession()]));
    const { container, findAllByTestId } = render(SessionList);
    await findAllByTestId('session-card');

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\bRepos\b/i);
    expect(text).not.toMatch(/\bConfig\b/i);
    expect(container.querySelector('[href*="/repos"]')).toBeNull();
    expect(container.querySelector('[href*="/config"]')).toBeNull();
    expect(container.querySelector('[href*="/projects"]')).toBeNull();
  });

  it('populates the shared sessionList store with the response total', async () => {
    listSessions.mockResolvedValue(response([makeSession(), makeSession({ session_id: 'c' })]));
    render(SessionList);
    await waitFor(() => expect(sessionList.total).toBe(2));
    expect(sessionList.items).toHaveLength(2);
  });
});
