/**
 * Tier 1 tests: Session-end notification — pure logic.
 * BACKLOG.md § P1.3
 */
import { describe, it, expect } from 'vitest';
import { shouldNotify, buildPayload } from '../../src/notify.js';
import type { SessionMeta } from '../../src/session-files.js';

describe('shouldNotify', () => {
  it('returns false when config is undefined', () => {
    expect(shouldNotify(undefined, 'completed')).toBe(false);
  });

  it('returns false when terminationReason is undefined', () => {
    expect(shouldNotify({ url: 'http://x', events: ['completed'] }, undefined)).toBe(false);
  });

  it('returns true when terminationReason is in events list', () => {
    const cfg = { url: 'http://x', events: ['completed', 'failed'] };
    expect(shouldNotify(cfg, 'completed')).toBe(true);
    expect(shouldNotify(cfg, 'failed')).toBe(true);
  });

  it('returns false when terminationReason is not in events list', () => {
    const cfg = { url: 'http://x', events: ['completed'] };
    expect(shouldNotify(cfg, 'timeout_inactivity')).toBe(false);
  });
});

describe('buildPayload', () => {
  it('builds correct payload from session meta', () => {
    const meta: SessionMeta = {
      session_id: 'abc-123',
      original_prompt: 'Fix CI',
      status: 'completed',
      created_at: 1000,
      completed_at: 2000,
      termination_reason: 'merged',
      prs: [{ repo: 'org/repo', pr_number: 42, registered_at: 1500 }],
    };

    const payload = buildPayload(meta);

    expect(payload).toEqual({
      session_id: 'abc-123',
      status: 'completed',
      termination_reason: 'merged',
      prs: [{ repo: 'org/repo', pr_number: 42, registered_at: 1500 }],
      started_at: 1000,
      ended_at: 2000,
      summary: 'Fix CI',
    });
  });

  it('uses "unknown" when termination_reason is undefined', () => {
    const meta: SessionMeta = {
      session_id: 'xyz',
      original_prompt: 'Test',
      status: 'failed',
      created_at: 100,
      completed_at: 200,
      prs: [],
    };

    const payload = buildPayload(meta);
    expect(payload.termination_reason).toBe('unknown');
  });
});
