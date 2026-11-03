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
    events_processed_24h: 0,
    tasks_succeeded_24h: 0,
    tasks_failed_24h: 0,
    recent_prs: [],
    cron_summary: [],
    health: 'healthy',
    version: '0.1.0',
    uptime_s: 3600,
    active_sessions_by_repo: [],
    recent_events: [],
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
    expect(cards).toHaveLength(9);
    const labels = cards.map((c) => c.getAttribute('data-label'));
    expect(labels).toEqual(['Active Sessions', 'Queued Work', 'Pending Wakes', 'Events (24h)', 'Tasks Done (24h)', 'Tasks Failed (24h)', 'Recent PRs (24h)', 'Health', 'Uptime']);
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
    // The "Recent PRs (24h)" card is the seventh stat card (index 6).
    const value = getAllByTestId('stat-card-value')[6];
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
          { name: 'nightly', repo: 'o/r', schedule: '0 9 * * *', state: 'active', next_fire: null, last_fired_at: null },
          { name: 'broken', repo: 'o/r', schedule: '0 0 * * *', state: 'error', next_fire: null, last_fired_at: '2026-11-01T09:00:00.000Z' },
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

  it('shows "Never" in the Last Fired column when last_fired_at is null (BACKLOG.md § P2.53)', async () => {
    getOverview.mockResolvedValue(
      makeOverview({
        cron_summary: [
          { name: 'fresh', repo: 'o/r', schedule: '0 9 * * *', state: 'active', next_fire: null, last_fired_at: null },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findAllByTestId } = render(Overview);
    const cells = await findAllByTestId('cron-last-fired');
    expect(cells).toHaveLength(1);
    expect(cells[0]?.textContent?.trim()).toBe('Never');
  });

  it('renders a timestamp in the Last Fired column when last_fired_at is a valid ISO string (BACKLOG.md § P2.53)', async () => {
    getOverview.mockResolvedValue(
      makeOverview({
        cron_summary: [
          { name: 'ran-today', repo: 'o/r', schedule: '0 9 * * *', state: 'active', next_fire: null, last_fired_at: '2026-11-03T09:00:00.000Z' },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findAllByTestId } = render(Overview);
    const cells = await findAllByTestId('cron-last-fired');
    expect(cells).toHaveLength(1);
    // Should NOT be "Never" and should be a non-empty string.
    const text = cells[0]?.textContent?.trim() ?? '';
    expect(text).not.toBe('Never');
    expect(text.length).toBeGreaterThan(0);
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

  // ---- events_processed_24h stat card (BACKLOG.md § P2.37) ----

  it('shows events_processed_24h in the Events (24h) stat card', async () => {
    getOverview.mockResolvedValue(makeOverview({ events_processed_24h: 42 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    // "Events (24h)" is the fourth card (index 3)
    const eventsCard = cards[3];
    expect(eventsCard?.getAttribute('data-label')).toBe('Events (24h)');
    const value = eventsCard?.querySelector('[data-testid="stat-card-value"]');
    expect(value?.textContent?.trim()).toBe('42');
  });

  it('shows events_processed_24h of 0 when no events have been processed in 24h', async () => {
    getOverview.mockResolvedValue(makeOverview({ events_processed_24h: 0 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    const eventsCard = cards[3];
    const value = eventsCard?.querySelector('[data-testid="stat-card-value"]');
    expect(value?.textContent?.trim()).toBe('0');
  });

  // ---- tasks_succeeded_24h stat card (BACKLOG.md § P2.42) ----

  it('shows tasks_succeeded_24h in the Tasks Done (24h) stat card', async () => {
    getOverview.mockResolvedValue(makeOverview({ tasks_succeeded_24h: 7 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    // "Tasks Done (24h)" is the fifth card (index 4)
    const card = cards[4];
    expect(card?.getAttribute('data-label')).toBe('Tasks Done (24h)');
    const value = card?.querySelector('[data-testid="stat-card-value"]');
    expect(value?.textContent?.trim()).toBe('7');
  });

  it('shows tasks_succeeded_24h of 0 when no tasks succeeded in 24h', async () => {
    getOverview.mockResolvedValue(makeOverview({ tasks_succeeded_24h: 0 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    const card = cards[4];
    const value = card?.querySelector('[data-testid="stat-card-value"]');
    expect(value?.textContent?.trim()).toBe('0');
  });

  // ---- tasks_failed_24h stat card (BACKLOG.md § P2.42) ----

  it('shows tasks_failed_24h in the Tasks Failed (24h) stat card', async () => {
    getOverview.mockResolvedValue(makeOverview({ tasks_failed_24h: 3 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    // "Tasks Failed (24h)" is the sixth card (index 5)
    const card = cards[5];
    expect(card?.getAttribute('data-label')).toBe('Tasks Failed (24h)');
    const value = card?.querySelector('[data-testid="stat-card-value"]');
    expect(value?.textContent?.trim()).toBe('3');
  });

  it('shows tasks_failed_24h of 0 when no tasks failed in 24h', async () => {
    getOverview.mockResolvedValue(makeOverview({ tasks_failed_24h: 0 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    const card = cards[5];
    const value = card?.querySelector('[data-testid="stat-card-value"]');
    expect(value?.textContent?.trim()).toBe('0');
  });

  // ---- stat card highlight behavior (BACKLOG.md § P2.44) ----

  it('Tasks Failed (24h) has data-highlight="danger" when tasks_failed_24h > 0', async () => {
    getOverview.mockResolvedValue(makeOverview({ tasks_failed_24h: 2 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    const failedCard = cards[5];
    expect(failedCard?.getAttribute('data-label')).toBe('Tasks Failed (24h)');
    expect(failedCard?.getAttribute('data-highlight')).toBe('danger');
  });

  it('Tasks Failed (24h) has no highlight when tasks_failed_24h === 0', async () => {
    getOverview.mockResolvedValue(makeOverview({ tasks_failed_24h: 0 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    const failedCard = cards[5];
    expect(failedCard?.getAttribute('data-label')).toBe('Tasks Failed (24h)');
    // When value is 0, no highlight attribute should be set.
    expect(failedCard?.getAttribute('data-highlight')).toBeNull();
  });

  it('Tasks Done (24h) has data-highlight="success" when tasks_succeeded_24h > 0', async () => {
    getOverview.mockResolvedValue(makeOverview({ tasks_succeeded_24h: 5 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    const doneCard = cards[4];
    expect(doneCard?.getAttribute('data-label')).toBe('Tasks Done (24h)');
    expect(doneCard?.getAttribute('data-highlight')).toBe('success');
  });

  it('Tasks Done (24h) has no highlight when tasks_succeeded_24h === 0', async () => {
    getOverview.mockResolvedValue(makeOverview({ tasks_succeeded_24h: 0 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    const doneCard = cards[4];
    expect(doneCard?.getAttribute('data-label')).toBe('Tasks Done (24h)');
    // When value is 0, no highlight attribute should be set.
    expect(doneCard?.getAttribute('data-highlight')).toBeNull();
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

  // ---- continuous_runs section (BACKLOG.md § P2.35) ----

  it('does not show the continuous-runs section when continuous_runs is absent', async () => {
    // `continuous_runs` is absent from the default makeOverview()
    getOverview.mockResolvedValue(makeOverview());
    listSessions.mockResolvedValue(makeSessionList([]));
    const { queryByTestId, findByTestId } = render(Overview);
    await findByTestId('stat-row'); // wait for load
    expect(queryByTestId('continuous-runs')).toBeNull();
  });

  it('does not show the continuous-runs section when continuous_runs is an empty array', async () => {
    getOverview.mockResolvedValue(makeOverview({ continuous_runs: [] }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { queryByTestId, findByTestId } = render(Overview);
    await findByTestId('stat-row');
    expect(queryByTestId('continuous-runs')).toBeNull();
  });

  it('shows the continuous-runs section with one running row', async () => {
    getOverview.mockResolvedValue(
      makeOverview({
        continuous_runs: [
          {
            repo: 'org/my-repo',
            status: 'running',
            items_completed: 3,
            current_session_id: 'sess-abc',
            started_at: Math.floor(Date.now() / 1000) - 120,
          },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    const section = await findByTestId('continuous-runs');
    expect(section).toBeTruthy();
    const rows = getAllByTestId('continuous-run-row');
    expect(rows).toHaveLength(1);
  });

  it('shows multiple rows when multiple continuous runs are present', async () => {
    getOverview.mockResolvedValue(
      makeOverview({
        continuous_runs: [
          {
            repo: 'org/repo-a',
            status: 'running',
            items_completed: 1,
            current_session_id: 'sess-1',
            started_at: Math.floor(Date.now() / 1000) - 60,
          },
          {
            repo: 'org/repo-b',
            status: 'stopped',
            stop_reason: 'queue_empty',
            items_completed: 5,
            current_session_id: null,
            started_at: Math.floor(Date.now() / 1000) - 300,
            stopped_at: Math.floor(Date.now() / 1000) - 10,
          },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('continuous-runs');
    const rows = getAllByTestId('continuous-run-row');
    expect(rows).toHaveLength(2);
  });

  // ---- uptime_s stat card (BACKLOG.md § P2.41) ----

  it('shows the Uptime stat card as the 7th card with a formatted value', async () => {
    getOverview.mockResolvedValue(makeOverview({ uptime_s: 5400 })); // 1h 30m
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    // "Uptime" is the ninth card (index 8)
    const uptimeCard = cards[8];
    expect(uptimeCard?.getAttribute('data-label')).toBe('Uptime');
    const value = uptimeCard?.querySelector('[data-testid="stat-card-value"]');
    expect(value?.textContent?.trim()).toBe('1h 30m');
  });

  it('shows "<1m" in Uptime card when uptime_s is 0', async () => {
    getOverview.mockResolvedValue(makeOverview({ uptime_s: 0 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    const uptimeCard = cards[8];
    const value = uptimeCard?.querySelector('[data-testid="stat-card-value"]');
    expect(value?.textContent?.trim()).toBe('<1m');
  });

  it('shows "2d 3h" in Uptime card for multi-day uptime', async () => {
    getOverview.mockResolvedValue(makeOverview({ uptime_s: 2 * 86400 + 3 * 3600 }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('stat-row');
    const cards = getAllByTestId('stat-card');
    const uptimeCard = cards[8];
    const value = uptimeCard?.querySelector('[data-testid="stat-card-value"]');
    expect(value?.textContent?.trim()).toBe('2d 3h');
  });

  // ---- version in PageHeader subtitle (BACKLOG.md § P2.41) ----

  it('shows the daemon version in the PageHeader subtitle', async () => {
    getOverview.mockResolvedValue(makeOverview({ version: '1.2.3' }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    // Wait for the stat row to appear (means data has loaded)
    await findByTestId('stat-row');
    const header = await findByTestId('page-header');
    const subtitle = header.querySelector('[data-testid="page-header-subtitle"]');
    expect(subtitle?.textContent).toContain('v1.2.3');
  });

  it('shows a different version string when the version changes', async () => {
    getOverview.mockResolvedValue(makeOverview({ version: '2.0.0-beta.1' }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    // Wait for the stat row to appear (means data has loaded)
    await findByTestId('stat-row');
    const header = await findByTestId('page-header');
    const subtitle = header.querySelector('[data-testid="page-header-subtitle"]');
    expect(subtitle?.textContent).toContain('v2.0.0-beta.1');
  });

  // ---- Activity by Repo section (BACKLOG.md § P2.45, P2.48) ----

  it('does not show the Activity by Repo section when active_sessions_by_repo is empty', async () => {
    getOverview.mockResolvedValue(makeOverview({ active_sessions_by_repo: [] }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, queryByTestId } = render(Overview);
    await findByTestId('stat-row');
    expect(queryByTestId('sessions-by-repo')).toBeNull();
  });

  it('shows the Activity by Repo section when active_sessions_by_repo has entries', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    getOverview.mockResolvedValue(
      makeOverview({
        active_sessions_by_repo: [
          { repo: 'org/repo-a', active: 2, completed_24h: 0, last_started_at: nowS - 100 },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    const section = await findByTestId('sessions-by-repo');
    expect(section).toBeTruthy();
    const rows = getAllByTestId('sessions-by-repo-row');
    expect(rows).toHaveLength(1);
  });

  it('renders one row per entry in active_sessions_by_repo', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    getOverview.mockResolvedValue(
      makeOverview({
        active_sessions_by_repo: [
          { repo: 'org/repo-a', active: 2, completed_24h: 1, last_started_at: nowS - 100 },
          { repo: 'org/repo-b', active: 0, completed_24h: 3, last_started_at: nowS - 200 },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('sessions-by-repo');
    const rows = getAllByTestId('sessions-by-repo-row');
    expect(rows).toHaveLength(2);
    // Each row should contain the repo name
    expect(rows[0]?.textContent).toContain('org/repo-a');
    expect(rows[1]?.textContent).toContain('org/repo-b');
  });

  it('renders last_started_at as a non-empty timestamp string when non-null', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    getOverview.mockResolvedValue(
      makeOverview({
        active_sessions_by_repo: [
          { repo: 'org/repo-a', active: 1, completed_24h: 0, last_started_at: nowS - 3600 },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('sessions-by-repo');
    const cells = getAllByTestId('last-started-at');
    expect(cells).toHaveLength(1);
    // A locale timestamp string — non-empty, not "—"
    expect(cells[0]?.textContent?.trim()).not.toBe('');
    expect(cells[0]?.textContent?.trim()).not.toBe('—');
  });

  it('renders "—" for last_started_at when null', async () => {
    getOverview.mockResolvedValue(
      makeOverview({
        active_sessions_by_repo: [
          { repo: 'org/repo-a', active: 0, completed_24h: 0, last_started_at: null },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('sessions-by-repo');
    const cells = getAllByTestId('last-started-at');
    expect(cells).toHaveLength(1);
    expect(cells[0]?.textContent?.trim()).toBe('—');
  });

  // ---- Recent Events section (BACKLOG.md § P2.47) ----

  it('does not show the Recent Events section when recent_events is empty', async () => {
    getOverview.mockResolvedValue(makeOverview({ recent_events: [] }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, queryByTestId } = render(Overview);
    await findByTestId('stat-row');
    expect(queryByTestId('recent-events')).toBeNull();
  });

  it('shows the Recent Events section when recent_events has entries', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    getOverview.mockResolvedValue(
      makeOverview({
        recent_events: [
          {
            event_type: 'check_run',
            repo: 'org/my-repo',
            pr_number: 42,
            wake_triggered: true,
            received_at: nowS,
          },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const section = await findByTestId('recent-events');
    expect(section).toBeTruthy();
  });

  it('renders one row per event in recent_events', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    getOverview.mockResolvedValue(
      makeOverview({
        recent_events: [
          { event_type: 'check_run', repo: 'org/repo-a', pr_number: 1, wake_triggered: true, received_at: nowS },
          { event_type: 'issue_comment', repo: 'org/repo-b', pr_number: null, wake_triggered: false, received_at: nowS - 60 },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('recent-events');
    const rows = getAllByTestId('recent-events-row');
    expect(rows).toHaveLength(2);
    // First row should contain the event type and repo
    expect(rows[0]?.textContent).toContain('check_run');
    expect(rows[0]?.textContent).toContain('org/repo-a');
    // Second row should show '—' for null pr_number
    expect(rows[1]?.textContent).toContain('—');
  });

  // ---- Recent PRs section (BACKLOG.md § P2.54) ----

  it('does not show the Recent PRs section when recent_prs is empty', async () => {
    getOverview.mockResolvedValue(makeOverview({ recent_prs: [] }));
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, queryByTestId } = render(Overview);
    await findByTestId('stat-row');
    expect(queryByTestId('recent-prs')).toBeNull();
  });

  it('shows the Recent PRs section when recent_prs has entries', async () => {
    getOverview.mockResolvedValue(
      makeOverview({
        recent_prs: [
          {
            title: 'Fix CI',
            repo: 'org/my-repo',
            url: 'https://github.com/org/my-repo/pull/42',
            state: 'open',
            opened_at: new Date().toISOString(),
          },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId } = render(Overview);
    const section = await findByTestId('recent-prs');
    expect(section).toBeTruthy();
  });

  it('renders one row per PR in recent_prs', async () => {
    getOverview.mockResolvedValue(
      makeOverview({
        recent_prs: [
          {
            title: 'Fix CI',
            repo: 'org/repo-a',
            url: 'https://github.com/org/repo-a/pull/1',
            state: 'open',
            opened_at: new Date().toISOString(),
          },
          {
            title: 'Add feature',
            repo: 'org/repo-b',
            url: 'https://github.com/org/repo-b/pull/2',
            state: 'merged',
            opened_at: new Date(Date.now() - 3600 * 1000).toISOString(),
          },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('recent-prs');
    const rows = getAllByTestId('recent-prs-row');
    expect(rows).toHaveLength(2);
  });

  it('each row contains the PR title text', async () => {
    getOverview.mockResolvedValue(
      makeOverview({
        recent_prs: [
          {
            title: 'Surface recent PRs table',
            repo: 'org/repo',
            url: 'https://github.com/org/repo/pull/10',
            state: 'open',
            opened_at: new Date().toISOString(),
          },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('recent-prs');
    const rows = getAllByTestId('recent-prs-row');
    expect(rows[0]?.textContent).toContain('Surface recent PRs table');
  });

  it('each row contains a clickable link to the PR URL', async () => {
    const prUrl = 'https://github.com/org/repo/pull/99';
    getOverview.mockResolvedValue(
      makeOverview({
        recent_prs: [
          {
            title: 'My PR',
            repo: 'org/repo',
            url: prUrl,
            state: 'open',
            opened_at: new Date().toISOString(),
          },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('recent-prs');
    const rows = getAllByTestId('recent-prs-row');
    const link = rows[0]?.querySelector('a');
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe(prUrl);
  });

  it('shows a StatusBadge for open and merged PR states', async () => {
    getOverview.mockResolvedValue(
      makeOverview({
        recent_prs: [
          {
            title: 'Open PR',
            repo: 'org/repo',
            url: 'https://github.com/org/repo/pull/1',
            state: 'open',
            opened_at: new Date().toISOString(),
          },
          {
            title: 'Merged PR',
            repo: 'org/repo',
            url: 'https://github.com/org/repo/pull/2',
            state: 'merged',
            opened_at: new Date(Date.now() - 3600 * 1000).toISOString(),
          },
        ],
      }),
    );
    listSessions.mockResolvedValue(makeSessionList([]));
    const { findByTestId, getAllByTestId } = render(Overview);
    await findByTestId('recent-prs');
    const rows = getAllByTestId('recent-prs-row');
    // Both open and merged states should render a StatusBadge
    expect(rows[0]?.querySelector('[data-testid="status-badge"]')).toBeTruthy();
    expect(rows[1]?.querySelector('[data-testid="status-badge"]')).toBeTruthy();
    // Open → 'active' state, Merged → 'paused' state
    expect(rows[0]?.querySelector('[data-testid="status-badge"]')?.getAttribute('data-state')).toBe('active');
    expect(rows[1]?.querySelector('[data-testid="status-badge"]')?.getAttribute('data-state')).toBe('paused');
  });
});
