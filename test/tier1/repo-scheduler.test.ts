/**
 * Tier 1 tests: circuit-breaker transition + status snapshot
 * (task-attempt-outcome, task 4.3).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  breakerTransition,
  statusSnapshot,
  INFRA_REASON_CODES,
  type RepoSlotState,
} from '../../src/repo-scheduler.js';
import type { AttemptEndState, ReasonCode } from '../../src/task-types.js';

const ALL_REASON_CODES: ReasonCode[] = [
  'spawn_failed',
  'auth_failed',
  'rate_limited',
  'git_push_failed',
  'adapter_crash',
  'no_changes',
  'agent_reported_failure',
  'agent_error',
  'agent_blocked',
  'budget_exceeded',
  'timed_out',
  'interrupted',
  'cancelled_by_api',
  'cancelled_by_breaker',
];

function closedState(failures = 0): Pick<RepoSlotState, 'breaker' | 'consecutiveFailures' | 'pausedAt'> {
  return { breaker: 'closed', consecutiveFailures: failures, pausedAt: null };
}

function infraEnd(reasonCode: ReasonCode, countsTowardBreaker?: boolean): AttemptEndState {
  const end: AttemptEndState = { outcome: 'failed', reasonCode, failureClass: 'infra' };
  if (countsTowardBreaker !== undefined) end.countsTowardBreaker = countsTowardBreaker;
  return end;
}

describe('breakerTransition — counting', () => {
  it('increments only for infra reason codes', () => {
    for (const rc of ALL_REASON_CODES) {
      const end: AttemptEndState = {
        outcome: rc === 'interrupted' ? 'interrupted' : 'failed',
        reasonCode: rc,
        failureClass: INFRA_REASON_CODES.has(rc) || rc === 'interrupted' ? 'infra' : null,
      };
      const result = breakerTransition(closedState(0), end, 3, 1000);
      if (INFRA_REASON_CODES.has(rc)) {
        expect(result.consecutiveFailures).toBe(1);
      } else {
        expect(result.consecutiveFailures).toBe(0);
      }
    }
  });

  it('does NOT increment a git_push_failed with countsTowardBreaker=false (ls-remote-null, H4)', () => {
    const result = breakerTransition(closedState(0), infraEnd('git_push_failed', false), 3, 1000);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.breaker).toBe('closed');
    expect(result.emit).toBeNull();
  });

  it('DOES increment a git_push_failed with countsTowardBreaker=true/omitted', () => {
    expect(breakerTransition(closedState(0), infraEnd('git_push_failed'), 3, 1000).consecutiveFailures).toBe(1);
    expect(breakerTransition(closedState(0), infraEnd('git_push_failed', true), 3, 1000).consecutiveFailures).toBe(1);
  });

  it('leaves the counter unchanged for cancelled/timed_out/budget_exceeded/interrupted/no_changes', () => {
    const nonCounting: AttemptEndState[] = [
      { outcome: 'cancelled', reasonCode: 'cancelled_by_api', failureClass: null },
      { outcome: 'failed', reasonCode: 'cancelled_by_breaker', failureClass: 'infra' },
      { outcome: 'timed_out', reasonCode: 'timed_out', failureClass: null },
      { outcome: 'budget_exceeded', reasonCode: 'budget_exceeded', failureClass: null },
      { outcome: 'interrupted', reasonCode: 'interrupted', failureClass: 'infra' },
      { outcome: 'failed', reasonCode: 'no_changes', failureClass: null },
    ];
    for (const end of nonCounting) {
      const result = breakerTransition(closedState(2), end, 3, 1000);
      expect(result.consecutiveFailures).toBe(2);
      expect(result.breaker).toBe('closed');
    }
  });
});

describe('breakerTransition — opening and closing', () => {
  it('opens exactly at the threshold and emits paused', () => {
    const below = breakerTransition(closedState(1), infraEnd('spawn_failed'), 3, 5000);
    expect(below.consecutiveFailures).toBe(2);
    expect(below.breaker).toBe('closed');
    expect(below.emit).toBeNull();

    const atThreshold = breakerTransition(closedState(2), infraEnd('spawn_failed'), 3, 5000);
    expect(atThreshold.consecutiveFailures).toBe(3);
    expect(atThreshold.breaker).toBe('open');
    expect(atThreshold.pausedAt).toBe(5000);
    expect(atThreshold.emit).toBe('paused');
  });

  it('resets and closes on succeeded, emitting repo.resumed(auto) when it was open', () => {
    const fromOpen = breakerTransition(
      { breaker: 'open', consecutiveFailures: 5, pausedAt: 1000 },
      { outcome: 'succeeded', reasonCode: null, failureClass: null },
      3,
      9000
    );
    expect(fromOpen.consecutiveFailures).toBe(0);
    expect(fromOpen.breaker).toBe('closed');
    expect(fromOpen.pausedAt).toBeNull();
    expect(fromOpen.emit).toBe('resumed');
    expect(fromOpen.resetBy).toBe('auto');

    const fromClosed = breakerTransition(
      closedState(2),
      { outcome: 'succeeded', reasonCode: null, failureClass: null },
      3,
      9000
    );
    expect(fromClosed.breaker).toBe('closed');
    expect(fromClosed.emit).toBeNull();
  });

  it('is idempotent while open (counter tracks, no new paused emission)', () => {
    const result = breakerTransition(
      { breaker: 'open', consecutiveFailures: 3, pausedAt: 1000 },
      infraEnd('auth_failed'),
      3,
      9000
    );
    expect(result.breaker).toBe('open');
    expect(result.consecutiveFailures).toBe(4);
    expect(result.pausedAt).toBe(1000); // unchanged while already open
    expect(result.emit).toBeNull();
  });

  it('half-open: a failed infra probe returns to open and resets pausedAt', () => {
    const result = breakerTransition(
      { breaker: 'half-open', consecutiveFailures: 3, pausedAt: 1000 },
      infraEnd('spawn_failed'),
      3,
      9000
    );
    expect(result.breaker).toBe('open');
    expect(result.pausedAt).toBe(9000);
  });

  it('half-open: a succeeded probe closes the breaker (resumed auto)', () => {
    const result = breakerTransition(
      { breaker: 'half-open', consecutiveFailures: 3, pausedAt: 1000 },
      { outcome: 'succeeded', reasonCode: null, failureClass: null },
      3,
      9000
    );
    expect(result.breaker).toBe('closed');
    expect(result.emit).toBe('resumed');
    expect(result.resetBy).toBe('auto');
  });
});

describe('breakerTransition — property', () => {
  it('increments iff reason code in infra set and countsTowardBreaker !== false', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_REASON_CODES),
        fc.option(fc.boolean(), { nil: undefined }),
        fc.integer({ min: 0, max: 10 }),
        (rc, counts, start) => {
          const end: AttemptEndState = {
            outcome: rc === 'interrupted' ? 'interrupted' : 'failed',
            reasonCode: rc,
            failureClass: INFRA_REASON_CODES.has(rc) || rc === 'interrupted' ? 'infra' : null,
          };
          if (counts !== undefined) end.countsTowardBreaker = counts;
          const result = breakerTransition(closedState(start), end, 100, 1000);
          const shouldIncrement = INFRA_REASON_CODES.has(rc) && counts !== false;
          expect(result.consecutiveFailures).toBe(shouldIncrement ? start + 1 : start);
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe('statusSnapshot', () => {
  it('produces the canonical flat shape', () => {
    const snap = statusSnapshot({
      repo: 'owner/name',
      inUse: 1,
      limit: 2,
      breaker: 'open',
      consecutiveFailures: 4,
      pausedAt: 1000,
      pausedUntil: 5000,
      probeInFlight: false,
    });
    expect(snap).toEqual({
      repo: 'owner/name',
      circuit_breaker_state: 'open',
      consecutive_failures: 4,
      paused_until: 5000,
      slots_total: 2,
      slots_in_use: 1,
    });
  });
});
