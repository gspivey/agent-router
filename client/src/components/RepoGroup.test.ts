import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import type { RepoGroup, SessionSummary } from '../lib/types.js';

/**
 * RepoGroup unit tests (spa-operator-restoration ROADMAP 80, Task A-6).
 *
 * Covers header rendering (PR badge, cron pill, active dot), collapse/expand
 * with localStorage persistence, auto-collapse of stale inactive repos, the
 * "Show more" paging button, and load-more de-duplication (FR-2.1–FR-2.6).
 * `api` is mocked so there is no live network.
 */

const listRepoPagedSessions = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    listRepoPagedSessions: (...args: unknown[]) => listRepoPagedSessions(...args),
  },
  AuthError: class AuthError extends Error {},
}));

const { default: RepoGroup } = await import('./RepoGroup.svelte');

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 'sess-1',
    repo: 'o/r',
    status: 'completed',
    created_at: Math.floor(Date.now() / 1000) - 300,
    completed_at: Math.floor(Date.now() / 1000) - 60,
    termination_reason: 'merged',
    prs: [],
    waiting_for: null,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<RepoGroup> = {}): RepoGroup {
  return {
    repo: 'gspivey/agent-router',
    active_sessions: [],
    terminal_sessions: [],
    terminal_total: 0,
    cron: null,
    open_pr_count: 0,
    closed_pr_count: 0,
    ...overrides,
  };
}

describe('RepoGroup — header (FR-2.2)', () => {
  beforeEach(() => {
    localStorage.clear();
    listRepoPagedSessions.mockReset();
    history.replaceState({}, '', '/app');
    location.hash = '';
  });
  afterEach(cleanup);

  it('renders the repo name in the header', () => {
    const { getByTestId } = render(RepoGroup, { group: makeGroup({ repo: 'o/foo' }) });
    expect(getByTestId('repo-toggle').textContent).toContain('o/foo');
  });

  it('renders a PR count badge linking to the repo pulls when open_pr_count > 0', () => {
    const { getByTestId } = render(RepoGroup, {
      group: makeGroup({ repo: 'gspivey/foo', open_pr_count: 3 }),
    });
    const badge = getByTestId('pr-count-badge');
    expect(badge.getAttribute('href')).toBe('https://github.com/gspivey/foo/pulls');
    expect(badge.textContent).toContain('3 PRs');
  });

  it('renders no PR badge when open_pr_count is 0', () => {
    const { queryByTestId } = render(RepoGroup, { group: makeGroup({ open_pr_count: 0 }) });
    expect(queryByTestId('pr-count-badge')).toBeNull();
  });

  it('renders a pulsing dot when there are active sessions', () => {
    const { getByTestId } = render(RepoGroup, {
      group: makeGroup({ active_sessions: [makeSession({ status: 'active', completed_at: null })] }),
    });
    const dot = getByTestId('active-dot');
    expect(dot.getAttribute('style')).toContain('pulse');
  });

  it('renders no pulsing dot when there are no active sessions', () => {
    const { queryByTestId } = render(RepoGroup, { group: makeGroup({ active_sessions: [] }) });
    expect(queryByTestId('active-dot')).toBeNull();
  });

  it('renders a "paused" pill when the cron is paused', () => {
    const { getByTestId } = render(RepoGroup, {
      group: makeGroup({ cron: { name: 'c', schedule: '* * * * *', paused: true, next_fire: null } }),
    });
    expect(getByTestId('cron-paused').textContent).toContain('paused');
  });

  it('renders cron info with schedule and next-fire when not paused', () => {
    const future = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    const { getByTestId } = render(RepoGroup, {
      group: makeGroup({
        cron: { name: 'c', schedule: '*/30 * * * *', paused: false, next_fire: future },
      }),
    });
    const info = getByTestId('cron-info');
    expect(info.textContent).toContain('*/30 * * * *');
    expect(info.textContent).toContain('next in');
  });

  it('renders no cron info when cron is null', () => {
    const { queryByTestId } = render(RepoGroup, { group: makeGroup({ cron: null }) });
    expect(queryByTestId('cron-info')).toBeNull();
    expect(queryByTestId('cron-paused')).toBeNull();
  });
});

describe('RepoGroup — collapse/expand (FR-2.5, FR-2.6)', () => {
  beforeEach(() => {
    localStorage.clear();
    listRepoPagedSessions.mockReset();
  });
  afterEach(cleanup);

  it('toggles body visibility and aria-expanded when the header is clicked', async () => {
    const { getByTestId, queryByTestId } = render(RepoGroup, {
      group: makeGroup({ repo: 'o/r', terminal_sessions: [makeSession()], terminal_total: 1 }),
    });
    // Default expanded (no stale, has terminal but recent completed_at).
    expect(getByTestId('repo-body')).toBeTruthy();
    expect(getByTestId('repo-toggle').getAttribute('aria-expanded')).toBe('true');

    await fireEvent.click(getByTestId('repo-toggle'));
    expect(queryByTestId('repo-body')).toBeNull();
    expect(getByTestId('repo-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem('ar-repo-collapsed-' + encodeURIComponent('o/r'))).toBe('1');

    await fireEvent.click(getByTestId('repo-toggle'));
    expect(localStorage.getItem('ar-repo-collapsed-' + encodeURIComponent('o/r'))).toBe('0');
  });

  it('auto-collapses a stale inactive repo when no localStorage key is set', () => {
    const old = Math.floor(Date.now() / 1000) - 48 * 3600;
    const { queryByTestId } = render(RepoGroup, {
      group: makeGroup({
        repo: 'o/stale',
        active_sessions: [],
        terminal_sessions: [makeSession({ completed_at: old })],
        terminal_total: 1,
      }),
    });
    expect(queryByTestId('repo-body')).toBeNull();
  });

  it('does NOT auto-collapse when localStorage key is "0" (user expanded)', () => {
    const old = Math.floor(Date.now() / 1000) - 48 * 3600;
    localStorage.setItem('ar-repo-collapsed-' + encodeURIComponent('o/stale'), '0');
    const { getByTestId } = render(RepoGroup, {
      group: makeGroup({
        repo: 'o/stale',
        active_sessions: [],
        terminal_sessions: [makeSession({ completed_at: old })],
        terminal_total: 1,
      }),
    });
    expect(getByTestId('repo-body')).toBeTruthy();
  });

  it('collapses when localStorage key is "1" regardless of other state', () => {
    localStorage.setItem('ar-repo-collapsed-' + encodeURIComponent('o/r'), '1');
    const { queryByTestId } = render(RepoGroup, {
      group: makeGroup({
        repo: 'o/r',
        active_sessions: [makeSession({ status: 'active', completed_at: null })],
        terminal_total: 0,
      }),
    });
    expect(queryByTestId('repo-body')).toBeNull();
  });

  it('does NOT auto-collapse a repo with zero terminal sessions', () => {
    const { getByTestId } = render(RepoGroup, {
      group: makeGroup({ repo: 'o/r', active_sessions: [], terminal_sessions: [], terminal_total: 0 }),
    });
    expect(getByTestId('repo-body')).toBeTruthy();
  });
});

describe('RepoGroup — show more (FR-2.4)', () => {
  beforeEach(() => {
    localStorage.clear();
    listRepoPagedSessions.mockReset();
  });
  afterEach(cleanup);

  it('renders "Show N more" when terminal_total exceeds loaded count', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => makeSession({ session_id: `s${i}` }));
    const { getByTestId } = render(RepoGroup, {
      group: makeGroup({ terminal_sessions: sessions, terminal_total: 8 }),
    });
    expect(getByTestId('show-more').textContent).toContain('Show 3 more');
  });

  it('renders no show-more button when all terminal sessions are loaded', () => {
    const sessions = Array.from({ length: 3 }, (_, i) => makeSession({ session_id: `s${i}` }));
    const { queryByTestId } = render(RepoGroup, {
      group: makeGroup({ terminal_sessions: sessions, terminal_total: 3 }),
    });
    expect(queryByTestId('show-more')).toBeNull();
  });

  it('appends de-duplicated sessions on load more', async () => {
    const sessions = Array.from({ length: 5 }, (_, i) => makeSession({ session_id: `s${i}` }));
    // Server returns one duplicate (s4) and two new ones.
    listRepoPagedSessions.mockResolvedValue({
      sessions: [makeSession({ session_id: 's4' }), makeSession({ session_id: 's5' }), makeSession({ session_id: 's6' })],
      total: 7,
      offset: 5,
      limit: 5,
    });
    const { getByTestId, getAllByTestId } = render(RepoGroup, {
      group: makeGroup({ terminal_sessions: sessions, terminal_total: 8 }),
    });
    await fireEvent.click(getByTestId('show-more'));
    await waitFor(() => expect(listRepoPagedSessions).toHaveBeenCalledTimes(1));
    // 5 original + 2 new (s5, s6), s4 de-duplicated → 7 cards.
    await waitFor(() => expect(getAllByTestId('session-card')).toHaveLength(7));
  });

  it('renders an inline error when load more fails', async () => {
    const sessions = Array.from({ length: 5 }, (_, i) => makeSession({ session_id: `s${i}` }));
    listRepoPagedSessions.mockRejectedValue(new Error('boom'));
    const { getByTestId, findByTestId } = render(RepoGroup, {
      group: makeGroup({ terminal_sessions: sessions, terminal_total: 8 }),
    });
    await fireEvent.click(getByTestId('show-more'));
    expect(await findByTestId('load-more-error')).toBeTruthy();
  });
});
