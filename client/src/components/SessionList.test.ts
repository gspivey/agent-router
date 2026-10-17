import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';
import type { RepoGroup, RepoSessionsResponse } from '../lib/types.js';

/**
 * SessionList unit tests (spa-operator-restoration ROADMAP 80, Task A-7).
 *
 * The list is populated from a SINGLE stubbed `api.listRepoSessions` call
 * (FR-2.3). We assert: a RepoGroup renders per repo, the empty/error states
 * render, and the old flat `/sessions` endpoint is NOT used. `api` is mocked so
 * there is no live network.
 */

const listRepoSessions = vi.fn();
const listRepoPagedSessions = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    listRepoSessions: (...args: unknown[]) => listRepoSessions(...args),
    listRepoPagedSessions: (...args: unknown[]) => listRepoPagedSessions(...args),
  },
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
const { AuthError } = await import('../lib/api.js');

function makeGroup(overrides: Partial<RepoGroup> = {}): RepoGroup {
  return {
    repo: 'o/r',
    active_sessions: [],
    terminal_sessions: [],
    terminal_total: 0,
    cron: null,
    open_pr_count: 0,
    closed_pr_count: 0,
    ...overrides,
  };
}

function response(repos: RepoGroup[]): RepoSessionsResponse {
  return { repos };
}

describe('SessionList', () => {
  beforeEach(() => {
    listRepoSessions.mockReset();
    listRepoPagedSessions.mockReset();
    localStorage.clear();
    history.replaceState({}, '', '/app');
    location.hash = '';
  });

  afterEach(cleanup);

  it('renders a RepoGroup per repo from a single listRepoSessions call (FR-2.3)', async () => {
    listRepoSessions.mockResolvedValue(
      response([makeGroup({ repo: 'gspivey/edit-director' }), makeGroup({ repo: 'gspivey/agent-router' })]),
    );

    const { findAllByTestId } = render(SessionList);
    const groups = await findAllByTestId('repo-group');
    expect(groups).toHaveLength(2);
    expect(listRepoSessions).toHaveBeenCalledTimes(1);
  });

  it('renders the empty state when there are no repos', async () => {
    listRepoSessions.mockResolvedValue(response([]));
    const { findByTestId } = render(SessionList);
    const empty = await findByTestId('list-empty');
    expect(empty).toBeTruthy();
    // The empty state carries a muted message (Req 14.1).
    expect(empty.textContent).toContain('No sessions yet.');
  });

  it('renders a PageHeader titled "Sessions" (Req 14.3)', async () => {
    listRepoSessions.mockResolvedValue(response([]));
    const { findByTestId } = render(SessionList);
    const header = await findByTestId('page-header');
    expect(header.querySelector('h1')?.textContent).toBe('Sessions');
  });

  it('renders a retriable error state on a non-auth failure', async () => {
    listRepoSessions.mockRejectedValue(new Error('network down'));
    const { findByTestId } = render(SessionList);
    expect(await findByTestId('list-error')).toBeTruthy();
    expect(await findByTestId('list-retry')).toBeTruthy();
  });

  it('does NOT render the error state on an AuthError (handled globally)', async () => {
    listRepoSessions.mockRejectedValue(new AuthError('expired'));
    const { queryByTestId } = render(SessionList);
    await waitFor(() => expect(listRepoSessions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryByTestId('list-loading')).toBeNull());
    expect(queryByTestId('list-error')).toBeNull();
  });
});
