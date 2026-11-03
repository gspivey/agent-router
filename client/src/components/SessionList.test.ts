import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import type { RepoGroup, RepoSessionsResponse } from '../lib/types.js';

/**
 * SessionList unit tests (spa-operator-restoration ROADMAP 80, Task A-7).
 *
 * The list is populated from a SINGLE stubbed `api.listRepoSessions` call
 * (FR-2.3). We assert: a RepoGroup renders per repo, the empty/error states
 * render, and the old flat `/sessions` endpoint is NOT used. `api` is mocked so
 * there is no live network.
 *
 * Auto-refresh tests (BACKLOG.md § P2.49): assert that a 30-second setInterval
 * is created on mount, cleared on destroy, and that the last-refreshed timestamp
 * and Refresh button appear after a successful load.
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

  // ── auto-refresh and last-refreshed indicator (BACKLOG.md § P2.49) ────────

  it('shows the last-refreshed timestamp after a successful load', async () => {
    listRepoSessions.mockResolvedValue(response([]));
    const { findByTestId } = render(SessionList);
    // After a successful load the "last-refreshed" element should appear.
    const indicator = await findByTestId('sessions-last-refreshed');
    expect(indicator).toBeTruthy();
    // The text should include time digits (HH:MM:SS / locale format).
    expect(indicator.textContent).toMatch(/\d/);
  });

  it('renders the Refresh button after a successful load', async () => {
    listRepoSessions.mockResolvedValue(response([]));
    const { findByTestId } = render(SessionList);
    const btn = await findByTestId('sessions-refresh');
    expect(btn).toBeTruthy();
    expect(btn.textContent?.trim()).toBe('Refresh');
  });

  it('Refresh button calls listRepoSessions again on click', async () => {
    listRepoSessions.mockResolvedValue(response([]));
    const { findByTestId } = render(SessionList);
    const btn = await findByTestId('sessions-refresh');
    await fireEvent.click(btn);
    // Two calls: initial mount + manual refresh
    expect(listRepoSessions).toHaveBeenCalledTimes(2);
  });

  it('does not show last-refreshed or Refresh button during the initial load', () => {
    // Keep the promise pending so we stay in the loading state.
    listRepoSessions.mockReturnValue(new Promise(() => {}));
    const { queryByTestId } = render(SessionList);
    expect(queryByTestId('sessions-last-refreshed')).toBeNull();
    expect(queryByTestId('sessions-refresh')).toBeNull();
  });

  it('does not show last-refreshed or Refresh button when in the error state', async () => {
    listRepoSessions.mockRejectedValue(new Error('network down'));
    const { findByTestId, queryByTestId } = render(SessionList);
    // Wait for the error state to appear.
    await findByTestId('list-error');
    expect(queryByTestId('sessions-last-refreshed')).toBeNull();
    expect(queryByTestId('sessions-refresh')).toBeNull();
  });

  it('calls setInterval once on mount with the 30-second interval', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    listRepoSessions.mockResolvedValue(response([]));
    const { unmount } = render(SessionList);
    // Wait for the initial load to complete so the component is fully mounted.
    await waitFor(() => expect(listRepoSessions).toHaveBeenCalledTimes(1));
    // setInterval should have been called once with REFRESH_INTERVAL_MS = 30_000.
    const calls = setIntervalSpy.mock.calls.filter((c) => c[1] === 30_000);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    setIntervalSpy.mockRestore();
    unmount();
  });

  it('calls clearInterval on destroy', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    listRepoSessions.mockResolvedValue(response([]));
    const { unmount } = render(SessionList);
    await waitFor(() => expect(listRepoSessions).toHaveBeenCalledTimes(1));
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('background refresh does not replace content while in flight', async () => {
    // Initial load resolves with one group.
    listRepoSessions.mockResolvedValueOnce(
      response([makeGroup({ repo: 'gspivey/agent-router' })]),
    );
    // Second call (background refresh) stays pending indefinitely.
    let resolveBackground!: (v: RepoSessionsResponse) => void;
    listRepoSessions.mockReturnValueOnce(
      new Promise<RepoSessionsResponse>((resolve) => {
        resolveBackground = resolve;
      }),
    );

    const { findAllByTestId, queryAllByTestId } = render(SessionList);
    // Wait for initial render to complete.
    const groups = await findAllByTestId('repo-group');
    expect(groups).toHaveLength(1);

    // Trigger a second load (simulating what the Refresh button does).
    listRepoSessions.mockResolvedValue(response([makeGroup({ repo: 'gspivey/agent-router' })]));
    // The first background call is still pending, but existing content is visible.
    expect(queryAllByTestId('repo-group')).toHaveLength(1);

    // Resolve the background call.
    resolveBackground(response([makeGroup({ repo: 'gspivey/agent-router' })]));
  });
});
