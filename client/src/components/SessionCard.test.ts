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

describe('SessionCard — metadata fields (spa-operator-restoration A-4)', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/app');
    location.hash = '';
  });
  afterEach(cleanup);

  it('renders the short id (first 8 chars of the UUID) in a monospace element (FR-1.1)', () => {
    const { getByTestId } = render(SessionCard, {
      session: makeSession({ session_id: 'abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }),
    });
    const el = getByTestId('short-id');
    expect(el.textContent).toBe('abc12345');
    expect(el.className).toContain('font-mono');
  });

  it('renders a PR link with the GitHub PR URL (FR-1.2)', () => {
    const { getByTestId } = render(SessionCard, {
      session: makeSession({
        prs: [{ repo: 'o/r', pr_number: 5, registered_at: 1 }],
      }),
    });
    const link = getByTestId('pr-link');
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/5');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('PR #5');
  });

  it('renders multiple PR links when there are multiple PRs (FR-1.2)', () => {
    const { getAllByTestId } = render(SessionCard, {
      session: makeSession({
        prs: [
          { repo: 'o/r', pr_number: 1, registered_at: 1 },
          { repo: 'o/r', pr_number: 2, registered_at: 2 },
        ],
      }),
    });
    const links = getAllByTestId('pr-link');
    expect(links).toHaveLength(2);
  });

  it('renders no PR links when prs is empty (FR-1.2)', () => {
    const { queryByTestId } = render(SessionCard, { session: makeSession({ prs: [] }) });
    expect(queryByTestId('pr-links')).toBeNull();
  });

  it('renders the termination reason pill for an ended session (FR-1.3)', () => {
    const { getByTestId } = render(SessionCard, {
      session: makeSession({ status: 'completed', termination_reason: 'merged', completed_at: null }),
    });
    expect(getByTestId('termination-reason').textContent).toContain('merged');
  });

  it('does NOT render the termination pill when the session is active (FR-1.3)', () => {
    const { queryByTestId } = render(SessionCard, {
      session: makeSession({ status: 'active', termination_reason: 'merged' }),
    });
    expect(queryByTestId('termination-reason')).toBeNull();
  });

  it('does NOT render the termination pill when there is no reason (FR-1.3)', () => {
    const { queryByTestId } = render(SessionCard, {
      session: makeSession({ status: 'completed', termination_reason: null }),
    });
    expect(queryByTestId('termination-reason')).toBeNull();
  });

  it('renders the duration for an ended session (FR-1.4)', () => {
    const { getByTestId } = render(SessionCard, {
      session: makeSession({
        status: 'completed',
        created_at: 1000,
        completed_at: 1000 + 780,
      }),
    });
    expect(getByTestId('session-duration').textContent).toContain('13m');
  });

  it('does NOT render the duration for an active session (FR-1.4)', () => {
    const { queryByTestId } = render(SessionCard, {
      session: makeSession({ status: 'active', completed_at: null }),
    });
    expect(queryByTestId('session-duration')).toBeNull();
  });

  it('places PR links OUTSIDE the <button> element (valid HTML)', () => {
    const { getByTestId } = render(SessionCard, {
      session: makeSession({ prs: [{ repo: 'o/r', pr_number: 7, registered_at: 1 }] }),
    });
    const button = getByTestId('session-card');
    const link = getByTestId('pr-link');
    expect(button.contains(link)).toBe(false);
  });
});
