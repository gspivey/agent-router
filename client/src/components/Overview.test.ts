import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import type { OverviewResponse, SessionListResponse, SessionSummary } from '../lib/types.js';

/**
 * Overview dashboard unit tests (spa-polish ROADMAP 89, Req 12 / 14.1).
 *
 * The page is populated from stubbed `api.getOverview()` + `api.listSessions()`
 * calls (mocked, no live network). Covers: skeleton loading states, the four
 * stat cards (Active Sessions, Queued Work, Recent PRs 24h, Health badge),
 * recent-sessions rendering and empty state, cron-summary rendering and empty
 * state, and the client-only "failed to fetch" error state with retry.
 */

const getOverview = vi.fn();
const listSessions = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    getOverview: (...args: unknown[]) => getOverview(...args),
    listSessions: (...args: unknown[]) => listSessions(...args),
  },
  AuthError: class AuthError extends Error {
    kind: 'missing' | 'expired';
    constructor(kind: 'missing' | 'expired') {
      super(kind);
      this.name = 'AuthError';
      this.kind = kind;
    }
  },
}));

const { default: Overview } = await import('./Overview.svelte');

function makeOverview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    active_sessions: 2,
    queue_depth: 5,
    recent_prs: [],
    cron_summary: [],
    health: 'healthy',
    version: '0.1.0',
    uptime_s: 3600,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 'sess-abcdef12',
    repo: 'gspivey/agent-router',
    status: 'active',
    created_at: Math.floor(Date.now() / 1000) - 300,
    completed_at: null,
    termination_reason: null,
    prs: [],
    waiting_for: null,
    ...overrides,
  };
}

function makeSessionList(sessions: SessionSummary[]): SessionListResponse {
  return { sessions, total: sessions.length, offset: 0, limit: 5 };
}

describe('Overview', () => {
  beforeEach(() => {
    getOverview.mockReset();
    listSessions.mockReset();
    history.replaceState({}, '', '/app');
    location.hash = '';
  });
  afterEach(cleanup);

  it('shows skeleton loading states while the requests are in flight', () => {
    getOverview.mockReturnValue(new Promise(() => {}));
    listSessions.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(Overview);
    expect(getByTestId('stat-row-skeleton')).toBeTruthy();
    expect(getByTestId('recent-sessions-skeleton')).toBeTruthy();
    expect(getByTestId('cron-summary-skeleton')).toBeTruthy();
  });

  it('renders a PageHeader', async () => {
    getOverview.mockResolvedValue(makeOverview());
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const header = await findByTestId('page-header');
    expect(header.querySelector('h1')?.textContent).toBe('Overview');
  });

  it('renders four stat cards with the overview values (Req 12.2)', async () => {
    getOverview.mockResolvedValue(makeOverview({ active_sessions: 7, queue_depth: 3 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    expect(cards).toHaveLength(4);
    const labels = cards.map((c) => c.getAttribute('data-label'));
    expect(labels).toEqual(['Active Sessions', 'Queued Work', 'Recent PRs (24h)', 'Health']);
  });

  it('counts only recent PRs opened within the last 24h (Req 12.2)', async () => {
    const nowIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    getOverview.mockResolvedValue(
      makeOverview({
        recent_prs: [
          { title: 'a', repo: 'o/r', url: 'u', state: 'open', opened_at: nowIso },
          { title: 'b', repo: 'o/r', url: 'u', state: 'open', opened_at: nowIso },
          { title: 'c', repo: 'o/r', url: 'u', state: 'merged', opened_at: oldIso },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    // The "Recent PRs (24h)" card is the third stat card.
    const value = getAllByTestId('stat-card-value')[2];
    expect(value?.textContent?.trim()).toBe('2');
  });

  it('renders a healthy Health badge when health is healthy', async () => {
    getOverview.mockResolvedValue(makeOverview({ health: 'healthy' }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const badge = await findByTestId('status-badge');
    expect(badge.getAttribute('data-state')).toBe('active');
    expect(badge.textContent).toContain('Healthy');
  });

  it('renders a degraded Health badge when health is degraded', async () => {
    getOverview.mockResolvedValue(makeOverview({ health: 'degraded' }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const badge = await findByTestId('status-badge');
    expect(badge.getAttribute('data-state')).toBe('paused');
    expect(badge.textContent).toContain('Degraded');
  });

  it('renders the recent sessions list (last five) via SessionCard (Req 12.4)', async () => {
    getOverview.mockResolvedValue(makeOverview());
    const sessions = Array.from({ length: 5 }, (_, i) =>
      makeSession({ session_id: `sess-${i}` }),
    );
    listSessions.mockResolvedValue(makeSessionList(sessions));
    const { findAllByTestId } = render(Overview);
    const cards = await findAllByTestId('session-card');
    expect(cards).toHaveLength(5);
  });

  it('shows the recent-sessions empty state when there are no sessions (Req 14.1)', async () => {
    getOverview.mockResolvedValue(makeOverview());
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    expect(await findByTestId('recent-sessions-empty')).toBeTruthy();
  });

  it('renders the cron summary rows with a StatusBadge (Req 12.5)', async () => {
    getOverview.mockResolvedValue(
      makeOverview({
        cron_summary: [
          { name: 'nightly', repo: 'o/r', schedule: '0 9 * * *', state: 'active', next_fire: null },
          { name: 'broken', repo: 'o/r', schedule: '0 0 * * *', state: 'error', next_fire: null },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findAllByTestId } = render(Overview);
    const rows = await findAllByTestId('cron-summary-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('nightly');
    // Each row carries a StatusBadge.
    expect(rows[1]?.querySelector('[data-testid="status-badge"]')?.getAttribute('data-state')).toBe(
      'error',
    );
  });

  it('shows the cron-summary empty state when there are no crons (Req 12.7)', async () => {
    getOverview.mockResolvedValue(makeOverview({ cron_summary: [] }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    expect(await findByTestId('cron-summary-empty')).toBeTruthy();
  });

  it('shows the error state with retry when getOverview fails', async () => {
    getOverview.mockRejectedValue(new Error('network down'));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    expect(await findByTestId('overview-error')).toBeTruthy();
    expect(await findByTestId('overview-retry')).toBeTruthy();
  });

  it('retry refetches the overview after an error', async () => {
    getOverview.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(makeOverview());
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const retry = await findByTestId('overview-retry');
    await fireEvent.click(retry);
    await findByTestId('stat-row');
    expect(getOverview).toHaveBeenCalledTimes(2);
  });

  it('does NOT render the error state on an AuthError (handled globally)', async () => {
    const { AuthError } = await import('../lib/api.js');
    getOverview.mockRejectedValue(new AuthError('expired'));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { queryByTestId } = render(Overview);
    await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryByTestId('stat-row-skeleton')).toBeNull());
    expect(queryByTestId('overview-error')).toBeNull();
  });
});
