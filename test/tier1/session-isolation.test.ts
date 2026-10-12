/**
 * Tier 1 tests: agent process isolation pure guards in session-mgr
 * (task 84.6 / FR-4.6 / FR-4.7).
 */
import { describe, it, expect } from 'vitest';
import {
  checkConcurrentProjectConflict,
  shouldReapWorkerProcesses,
} from '../../src/session-mgr.js';

describe('checkConcurrentProjectConflict (FR-4.6)', () => {
  it('throws when a cross-project session is already active (useWorkerUid=true)', () => {
    expect(() =>
      checkConcurrentProjectConflict(
        'owner/new-repo',
        [{ sessionId: 's-existing', repo: 'owner/other-repo' }],
        true,
      ),
    ).toThrow(/Cannot spawn concurrent sessions for different projects/);
  });

  it('allows a same-project session (case-insensitive)', () => {
    expect(() =>
      checkConcurrentProjectConflict(
        'Owner/Repo',
        [{ sessionId: 's-existing', repo: 'owner/repo' }],
        true,
      ),
    ).not.toThrow();
  });

  it('allows when no sessions are active', () => {
    expect(() => checkConcurrentProjectConflict('owner/repo', [], true)).not.toThrow();
  });

  it('is a no-op when useWorkerUid is false (even with a cross-project session)', () => {
    expect(() =>
      checkConcurrentProjectConflict(
        'owner/new-repo',
        [{ sessionId: 's-existing', repo: 'owner/other-repo' }],
        false,
      ),
    ).not.toThrow();
  });

  it('is a no-op when newRepo is undefined', () => {
    expect(() =>
      checkConcurrentProjectConflict(undefined, [{ sessionId: 's', repo: 'owner/x' }], true),
    ).not.toThrow();
  });

  it('ignores sessions with no bound repo', () => {
    expect(() =>
      checkConcurrentProjectConflict('owner/repo', [{ sessionId: 's', repo: undefined }], true),
    ).not.toThrow();
  });

  it('the force flag cannot bypass the refusal (guard is independent of force)', () => {
    // The pure guard has no force parameter — createSession applies it AFTER
    // the force check, so force can never reach past it. This test documents
    // that: a cross-project conflict throws regardless of any caller intent.
    expect(() =>
      checkConcurrentProjectConflict(
        'owner/new',
        [{ sessionId: 's1', repo: 'owner/old' }],
        true,
      ),
    ).toThrow();
  });
});

describe('shouldReapWorkerProcesses (FR-4.7)', () => {
  it('returns false while sibling worker sessions remain active', () => {
    expect(shouldReapWorkerProcesses(1)).toBe(false);
    expect(shouldReapWorkerProcesses(2)).toBe(false);
  });

  it('returns true only when the last worker session has ended', () => {
    expect(shouldReapWorkerProcesses(0)).toBe(true);
  });
});
