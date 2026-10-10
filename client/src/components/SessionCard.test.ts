import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import SessionCard from './SessionCard.svelte';
import type { SessionSummary } from '../lib/types.js';
import { statusToBadge, type SessionStatus } from '../lib/logic.js';

/**
 * SessionCard unit tests (spa-overhaul Task 4 / ROADMAP 74).
 *
 * Asserts the card renders the status badge with the color derived from
 * `statusToBadge` (Req 5.2), shows the repo name / timestamp / `waiting_for`
 * (Req 5.1), and navigates to the chat route on activation (Req 5.6).
 */

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

describe('SessionCard', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/app');
    location.hash = '';
  });

  afterEach(cleanup);

  it('renders the repo name and the status badge text', () => {
    const { getByTestId } = render(SessionCard, { session: makeSession() });
    const card = getByTestId('session-card');
    expect(card.textContent).toContain('test-org/test-repo');
    expect(getByTestId('status-badge').textContent).toContain('active');
  });

  it('falls back to "no repo" when repo is null', () => {
    const { getByTestId } = render(SessionCard, { session: makeSession({ repo: null }) });
    expect(getByTestId('session-card').textContent).toContain('no repo');
  });

  it('renders waiting_for when present and omits it when null (Req 5.1)', () => {
    const { getByTestId, queryByTestId } = render(SessionCard, {
      session: makeSession({ waiting_for: 'waiting: tool' }),
    });
    expect(getByTestId('waiting-for').textContent).toContain('waiting: tool');
    cleanup();

    const { queryByTestId: q2 } = render(SessionCard, { session: makeSession({ waiting_for: null }) });
    expect(q2('waiting-for')).toBeNull();
    expect(queryByTestId).toBeDefined();
  });

  it('maps each status to the badge color from statusToBadge (Req 5.2)', () => {
    const cases: Array<{ status: SessionStatus; badge: string }> = [
      { status: 'active', badge: 'green' },
      { status: 'completed', badge: 'gray' },
      { status: 'abandoned', badge: 'yellow' },
      { status: 'failed', badge: 'red' },
    ];
    for (const { status, badge } of cases) {
      expect(statusToBadge(status)).toBe(badge);
      const { getByTestId } = render(SessionCard, { session: makeSession({ status }) });
      expect(getByTestId('status-badge').getAttribute('data-badge')).toBe(badge);
      cleanup();
    }
  });

  it('navigates to #/sessions/<id> when activated (Req 5.6)', async () => {
    const { getByTestId } = render(SessionCard, { session: makeSession({ session_id: 'go-here' }) });
    await fireEvent.click(getByTestId('session-card'));
    expect(location.hash).toBe('#/sessions/go-here');
  });
});
