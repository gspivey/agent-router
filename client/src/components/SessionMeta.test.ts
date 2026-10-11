import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import SessionMeta from './SessionMeta.svelte';
import type { SessionMeta as SessionMetaType } from '../lib/types.js';

/**
 * SessionMeta unit tests (spa-operator-restoration Task B-5 / ROADMAP 81).
 *
 * Covers FR-3.1 (metadata rows, PR links, copy button) and FR-3.2
 * (toggleable collapse).
 */

function makeMeta(overrides: Partial<SessionMetaType> = {}): SessionMetaType {
  return {
    session_id: 'abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    repo: 'owner/repo',
    status: 'completed',
    created_at: 1000,
    completed_at: 1780,
    termination_reason: 'merged',
    prs: [{ repo: 'owner/repo', pr_number: 42, registered_at: 1000 }],
    ...overrides,
  };
}

describe('SessionMeta', () => {
  afterEach(cleanup);

  it('renders the panel with the full UUID', () => {
    const { getByTestId } = render(SessionMeta, { meta: makeMeta() });
    expect(getByTestId('session-meta-panel')).toBeTruthy();
    expect(getByTestId('session-id').textContent).toContain(
      'abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    );
  });

  it('renders a PR link with the correct href', () => {
    const { getByTestId } = render(SessionMeta, { meta: makeMeta() });
    const link = getByTestId('session-meta-pr-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/owner/repo/pull/42');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('renders the duration for an ended session (13m)', () => {
    const { getByTestId } = render(SessionMeta, { meta: makeMeta() });
    expect(getByTestId('session-meta-duration').textContent).toContain('13m');
  });

  it('renders the termination reason row when set and not active', () => {
    const { getByTestId } = render(SessionMeta, { meta: makeMeta() });
    expect(getByTestId('session-meta-termination').textContent).toContain('merged');
  });

  it('omits completed, duration, and termination rows for an active session', () => {
    const active: SessionMetaType = {
      session_id: 'abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      repo: 'owner/repo',
      status: 'active',
      created_at: 1000,
      completed_at: null,
      prs: [],
    };
    const { queryByTestId } = render(SessionMeta, { meta: active });
    expect(queryByTestId('session-meta-completed')).toBeNull();
    expect(queryByTestId('session-meta-duration')).toBeNull();
    expect(queryByTestId('session-meta-termination')).toBeNull();
  });

  it('renders the repo link when repo is set and omits it when absent', () => {
    const { getByTestId } = render(SessionMeta, { meta: makeMeta() });
    const repoLink = getByTestId('session-meta-repo') as HTMLAnchorElement;
    expect(repoLink.getAttribute('href')).toBe('https://github.com/owner/repo');
    cleanup();
    const noRepo: SessionMetaType = {
      session_id: 'abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      status: 'completed',
      created_at: 1000,
      completed_at: 1780,
      prs: [],
    };
    const { queryByTestId } = render(SessionMeta, { meta: noRepo });
    expect(queryByTestId('session-meta-repo')).toBeNull();
  });

  it('toggles the panel body open and closed', async () => {
    const { getByTestId, queryByTestId } = render(SessionMeta, { meta: makeMeta() });
    const toggle = getByTestId('session-meta-toggle');
    const initiallyVisible = queryByTestId('session-id') !== null;
    await fireEvent.click(toggle);
    expect(queryByTestId('session-id') !== null).toBe(!initiallyVisible);
    await fireEvent.click(toggle);
    expect(queryByTestId('session-id') !== null).toBe(initiallyVisible);
  });

  it('copies the full UUID to the clipboard on copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    // Ensure the body is expanded so the copy button is present.
    const { getByTestId, queryByTestId } = render(SessionMeta, { meta: makeMeta() });
    if (queryByTestId('session-id-copy') === null) {
      await fireEvent.click(getByTestId('session-meta-toggle'));
    }
    await fireEvent.click(getByTestId('session-id-copy'));
    expect(writeText).toHaveBeenCalledWith('abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
  });
});
