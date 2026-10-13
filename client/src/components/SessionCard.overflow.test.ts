import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import SessionCard from './SessionCard.svelte';
import type { SessionSummary } from '../lib/types.js';

/**
 * SessionCard overflow-fix unit tests (spa-polish ROADMAP 87, Req 6.1–6.3).
 *
 * Structural assertions (jsdom does not lay out, so the 320px no-overflow
 * guarantee is the manual browser acceptance criterion in task 6.1): the
 * button row carries `min-w-0`, the subtitle carries `break-words` +
 * `line-clamp-2` + inline `overflow-wrap: anywhere`, and the repo/title line
 * keeps `truncate`.
 */
function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: 'sess-overflow-1',
    repo: 'test-org/a-very-long-repo-name-that-could-overflow-on-mobile-viewports',
    status: 'active',
    created_at: 1_700_000_000,
    completed_at: null,
    termination_reason: null,
    prs: [],
    waiting_for: null,
    ...overrides,
  };
}

describe('SessionCard overflow fix', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/app');
    location.hash = '';
  });
  afterEach(cleanup);

  it('gives the button row min-w-0 so children can shrink', () => {
    const { getByTestId } = render(SessionCard, { session: makeSession() });
    expect(getByTestId('session-card').className).toContain('min-w-0');
  });

  it('applies break-words + line-clamp-2 + overflow-wrap to the subtitle', () => {
    const { getByTestId } = render(SessionCard, { session: makeSession() });
    const subtitle = getByTestId('session-subtitle');
    expect(subtitle.className).toContain('min-w-0');
    expect(subtitle.className).toContain('break-words');
    expect(subtitle.className).toContain('line-clamp-2');
    expect(subtitle.getAttribute('style')).toContain('overflow-wrap: anywhere');
  });

  it('keeps the repo/title line single-line (truncate)', () => {
    const { getByTestId } = render(SessionCard, { session: makeSession() });
    const card = getByTestId('session-card');
    const title = card.querySelector('.truncate');
    expect(title).not.toBeNull();
    expect(title!.textContent).toContain('a-very-long-repo-name');
  });
});
