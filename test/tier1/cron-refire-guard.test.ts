import { describe, it, expect } from 'vitest';
import { canCronRefire } from '../../src/cron-guard.js';
import type { SessionMeta } from '../../src/session-files.js';

function makeMeta(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    session_id: 'test-session-id',
    original_prompt: 'test prompt',
    repo: 'owner/repo',
    status: 'completed',
    created_at: Date.now(),
    completed_at: Date.now(),
    prs: [],
    ...overrides,
  };
}

describe('canCronRefire', () => {
  it('allows re-fire when no previous sessions exist', () => {
    expect(canCronRefire(undefined)).toBe(true);
  });

  it('allows re-fire after a completed session', () => {
    const last = makeMeta({ status: 'completed' });
    expect(canCronRefire(last)).toBe(true);
  });

  it('allows re-fire after an abandoned session', () => {
    const last = makeMeta({ status: 'abandoned' });
    expect(canCronRefire(last)).toBe(true);
  });

  it('blocks re-fire after a failed session', () => {
    const last = makeMeta({ status: 'failed' });
    expect(canCronRefire(last)).toBe(false);
  });

  it('blocks re-fire while a session is active', () => {
    const last = makeMeta({ status: 'active', completed_at: null });
    expect(canCronRefire(last)).toBe(false);
  });
});
