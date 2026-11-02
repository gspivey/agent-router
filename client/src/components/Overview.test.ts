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
    pending_wakes_count: 0,
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
    expect(cards).toHaveLength(5);
    const labels = cards.map((c) => c.getAttribute('data-label'));
    expect(labels).toEqual(['Active Sessions', 'Queued Work', 'Pending Wakes', 'Recent PRs (24h)', 'Health']);
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
    // The "Recent PRs (24h)" card is the fourth stat card (index 3).
    const value = getAllByTestId('stat-card-value')[3];
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

  // ---- restart_required banner (BACKLOG.md § P2.30) ----

  it('does not show restart-required banner when restart_required is absent', async () => {
    getOverview.mockResolvedValue(makeOverview({ /* no restart_required */ }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { queryByTestId } = render(Overview);
    await waitFor(() => expect(queryByTestId('stat-row-skeleton')).toBeNull());
    expect(queryByTestId('restart-required-banner')).toBeNull();
  });

  it('shows amber restart-required banner with affected fields when restart_required is set', async () => {
    const since = new Date('2026-11-02T12:00:00.000Z').toISOString();
    getOverview.mockResolvedValue(
      makeOverview({
        restart_required: { fields: ['kiroPath'], since },
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const banner = await findByTestId('restart-required-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('kiroPath');
  });

  it('shows all affected fields in the banner when multiple fields changed', async () => {
    const since = new Date().toISOString();
    getOverview.mockResolvedValue(
      makeOverview({
        restart_required: { fields: ['port', 'controlPort'], since },
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const banner = await findByTestId('restart-required-banner');
    expect(banner.textContent).toContain('port');
    expect(banner.textContent).toContain('controlPort');
  });

  // ---- token_expiry banner (BACKLOG.md § P2.33) ----

  it('does not show token-expiry banner when token_expiry is absent', async () => {
    getOverview.mockResolvedValue(makeOverview({ /* no token_expiry */ }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { queryByTestId } = render(Overview);
    await waitFor(() => expect(queryByTestId('stat-row-skeleton')).toBeNull());
    expect(queryByTestId('token-expiry-banner')).toBeNull();
  });

  it('shows amber token-expiry banner with days remaining when severity is warn', async () => {
    const expiresAt = new Date(Date.now() + 10 * 86400 * 1000).toISOString();
    getOverview.mockResolvedValue(
      makeOverview({
        token_expiry: { days_remaining: 10, severity: 'warn', expires_at: expiresAt },
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const banner = await findByTestId('token-expiry-banner');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('10');
  });

  it('shows red token-expiry banner when severity is error', async () => {
    const expiresAt = new Date(Date.now() + 1 * 86400 * 1000).toISOString();
    getOverview.mockResolvedValue(
      makeOverview({
        token_expiry: { days_remaining: 1, severity: 'error', expires_at: expiresAt },
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const banner = await findByTestId('token-expiry-banner');
    expect(banner).toBeTruthy();
    // Error banner uses red border/background CSS classes
    expect(banner.className).toContain('error');
  });

  it('shows "expired" message when days_remaining is negative', async () => {
    const expiresAt = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
    getOverview.mockResolvedValue(
      makeOverview({
        token_expiry: { days_remaining: -5, severity: 'error', expires_at: expiresAt },
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const banner = await findByTestId('token-expiry-banner');
    expect(banner.textContent).toContain('expired');
    expect(banner.textContent).toContain('5');
  });

  it('shows both restart-required and token-expiry banners when both are set', async () => {
    const since = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
    getOverview.mockResolvedValue(
      makeOverview({
        restart_required: { fields: ['kiroPath'], since },
        token_expiry: { days_remaining: 3, severity: 'error', expires_at: expiresAt },
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    expect(await findByTestId('restart-required-banner')).toBeTruthy();
    expect(await findByTestId('token-expiry-banner')).toBeTruthy();
  });

  // ---- pending_wakes_count stat card (BACKLOG.md § P2.34) ----

  it('shows pending_wakes_count in the Pending Wakes stat card', async () => {
    getOverview.mockResolvedValue(makeOverview({ pending_wakes_count: 3 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    // "Pending Wakes" is the third card (index 2)
    const pendingCard = cards[2];
    expect(pendingCard?.getAttribute('data-label')).toBe('Pending Wakes');
    const value = pendingCard?.querySelector('[data-testid="stat-card-value"]');
    expect(value?.textContent?.trim()).toBe('3');
  });

  it('shows pending_wakes_count of 0 when no wakes are pending', async () => {
    getOverview.mockResolvedValue(makeOverview({ pending_wakes_count: 0 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    const pendingCard = cards[2];
    const value = pendingCard?.querySelector('[data-testid="stat-card-value"]');
    expect(value?.textContent?.trim()).toBe('0');
  });

  // ---- auto-refresh and last-refreshed indicator (BACKLOG.md § P2.34) ----

  it('shows the last-refreshed timestamp after a successful load', async () => {
    getOverview.mockResolvedValue(makeOverview());
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    // After a successful load the "last-refreshed" element should appear.
    const indicator = await findByTestId('last-refreshed');
    expect(indicator).toBeTruthy();
    // The text should include time digits (HH:MM:SS / locale format).
    expect(indicator.textContent).toMatch(/\d/);
  });

  it('renders the Refresh button after a successful load', async () => {
    getOverview.mockResolvedValue(makeOverview());
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const btn = await findByTestId('overview-refresh');
    expect(btn).toBeTruthy();
    expect(btn.textContent?.trim()).toBe('Refresh');
  });

  it('Refresh button calls getOverview again on click', async () => {
    getOverview.mockResolvedValue(makeOverview());
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const btn = await findByTestId('overview-refresh');
    await fireEvent.click(btn);
    // Two calls: initial mount + manual refresh
    expect(getOverview).toHaveBeenCalledTimes(2);
  });

  it('does not show last-refreshed or Refresh button while the initial load is in flight', () => {
    getOverview.mockReturnValue(new Promise(() => {}));
    listSessions.mockReturnValue(new Promise(() => {}));
    const { queryByTestId } = render(Overview);
    expect(queryByTestId('last-refreshed')).toBeNull();
    expect(queryByTestId('overview-refresh')).toBeNull();
  });
});
