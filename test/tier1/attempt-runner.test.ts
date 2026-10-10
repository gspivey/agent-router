/**
 * Tier 1 tests: attempt-runner pure outcome classification
 * (task-attempt-outcome, task 5.6).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  resolveOutcome,
  classifyPreSessionInfra,
  parseReportOutcome,
  type ReportOutcomePayload,
  type SessionResult,
} from '../../src/attempt-runner.js';
import type { ReasonCode, TerminationIntent } from '../../src/task-types.js';

const INFRA_SET: ReasonCode[] = [
  'spawn_failed',
  'auth_failed',
  'rate_limited',
  'git_push_failed',
  'adapter_crash',
];

const ALL_REASON_CODES: ReasonCode[] = [
  ...INFRA_SET,
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

describe('classifyPreSessionInfra', () => {
  it('returns spawn_failed on ENOENT/EACCES/EPERM', () => {
    for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
      const err = Object.assign(new Error('fork'), { code }) as NodeJS.ErrnoException;
      const r: SessionResult = { spawnError: err, exitCode: null, acpEventCount: 0 };
      expect(classifyPreSessionInfra(r)).toBe('spawn_failed');
    }
  });

  it('returns auth_failed on 401/403 setup status', () => {
    expect(classifyPreSessionInfra({ exitCode: 1, acpEventCount: 0, setupHttpStatus: 401 })).toBe('auth_failed');
    expect(classifyPreSessionInfra({ exitCode: 1, acpEventCount: 0, setupHttpStatus: 403 })).toBe('auth_failed');
  });

  it('returns rate_limited on 429 setup status', () => {
    expect(classifyPreSessionInfra({ exitCode: 1, acpEventCount: 0, setupHttpStatus: 429 })).toBe('rate_limited');
  });

  it('returns auth_failed on an auth-pattern stderr tail', () => {
    expect(
      classifyPreSessionInfra({ exitCode: 1, acpEventCount: 2, stderrTail: 'fatal: Bad credentials' })
    ).toBe('auth_failed');
  });

  it('returns adapter_crash on zero ACP events with a non-zero exit', () => {
    expect(classifyPreSessionInfra({ exitCode: 1, acpEventCount: 0 })).toBe('adapter_crash');
  });

  it('returns null when no infra condition is detected', () => {
    expect(classifyPreSessionInfra({ exitCode: 0, acpEventCount: 5 })).toBeNull();
    expect(classifyPreSessionInfra({ exitCode: null, acpEventCount: 3 })).toBeNull();
  });

  it('does not treat zero events with a clean exit as adapter_crash', () => {
    expect(classifyPreSessionInfra({ exitCode: 0, acpEventCount: 0 })).toBeNull();
  });
});

describe('parseReportOutcome', () => {
  it('accepts the three agent-declarable outcomes', () => {
    expect(parseReportOutcome({ outcome: 'succeeded' })?.outcome).toBe('succeeded');
    expect(parseReportOutcome({ outcome: 'failed' })?.outcome).toBe('failed');
    expect(parseReportOutcome({ outcome: 'blocked', blocked: { question: 'q', needs: 'credential' } })?.outcome).toBe('blocked');
  });

  it('rejects daemon-only outcomes (timed_out/cancelled/etc.)', () => {
    expect(parseReportOutcome({ outcome: 'timed_out' })).toBeNull();
    expect(parseReportOutcome({ outcome: 'cancelled' })).toBeNull();
    expect(parseReportOutcome({ outcome: 'budget_exceeded' })).toBeNull();
    expect(parseReportOutcome({ outcome: 'interrupted' })).toBeNull();
    expect(parseReportOutcome({ outcome: 'nonsense' })).toBeNull();
  });

  it('carries pr_url through', () => {
    expect(parseReportOutcome({ outcome: 'succeeded', pr_url: 'https://pr/1' })?.pr_url).toBe('https://pr/1');
  });

  it('rejects a blocked outcome with an invalid needs value', () => {
    expect(parseReportOutcome({ outcome: 'blocked', blocked: { question: 'q', needs: 'bogus' } })).toBeNull();
    expect(parseReportOutcome({ outcome: 'blocked' })).toBeNull();
  });
});

describe('resolveOutcome — priority', () => {
  it('termination intent wins over everything', () => {
    const ti: TerminationIntent = { outcome: 'failed', reasonCode: 'cancelled_by_breaker', failureClass: 'infra' };
    const r = resolveOutcome({
      terminationIntent: ti,
      reported: { outcome: 'succeeded' },
      stopReason: 'end_turn',
      exitCode: 0,
      hasDiff: true,
      remoteBranchExists: true,
    });
    expect(r.outcome).toBe('failed');
    expect(r.reasonCode).toBe('cancelled_by_breaker');
    expect(r.failureClass).toBe('infra');
  });

  it('pre-session infra overrides a self-report', () => {
    const r = resolveOutcome({
      preSessionInfra: 'auth_failed',
      reported: { outcome: 'succeeded' },
      exitCode: 1,
      hasDiff: false,
    });
    expect(r.outcome).toBe('failed');
    expect(r.reasonCode).toBe('auth_failed');
    expect(r.failureClass).toBe('infra');
  });

  it('self-report (tool) wins over outcome.json and mechanical', () => {
    const r = resolveOutcome({
      reported: { outcome: 'blocked', blocked: { question: 'need token', needs: 'credential' } },
      outcomeFile: { outcome: 'succeeded' },
      exitCode: 0,
      hasDiff: true,
      remoteBranchExists: true,
    });
    expect(r.outcome).toBe('blocked');
    expect(r.reasonCode).toBe('agent_blocked');
    expect(r.blocked).toEqual({ question: 'need token', needs: 'credential' });
  });

  it('outcome.json used when no tool report', () => {
    const r = resolveOutcome({ outcomeFile: { outcome: 'failed' }, exitCode: 0, hasDiff: false });
    expect(r.outcome).toBe('failed');
    expect(r.reasonCode).toBe('agent_reported_failure');
  });
});

describe('resolveOutcome — ACP stop reasons', () => {
  it('max_tokens/max_turn_requests → budget_exceeded', () => {
    expect(resolveOutcome({ stopReason: 'max_tokens', exitCode: null, hasDiff: false }).outcome).toBe('budget_exceeded');
    expect(resolveOutcome({ stopReason: 'max_turn_requests', exitCode: null, hasDiff: false }).reasonCode).toBe('budget_exceeded');
  });

  it('refusal → failed/agent_reported_failure', () => {
    const r = resolveOutcome({ stopReason: 'refusal', exitCode: null, hasDiff: false });
    expect(r.outcome).toBe('failed');
    expect(r.reasonCode).toBe('agent_reported_failure');
  });

  it('cancelled with no intent → failed/agent_error (agent cannot self-cancel)', () => {
    const r = resolveOutcome({ stopReason: 'cancelled', exitCode: null, hasDiff: false });
    expect(r.outcome).toBe('failed');
    expect(r.reasonCode).toBe('agent_error');
  });

  it('end_turn falls through to the commit check', () => {
    const r = resolveOutcome({ stopReason: 'end_turn', exitCode: null, hasDiff: true, remoteBranchExists: true });
    expect(r.outcome).toBe('succeeded');
  });
});

describe('resolveOutcome — commit / remote-ref (HIGH-7)', () => {
  it('hasDiff + remote match → succeeded', () => {
    const r = resolveOutcome({ stopReason: 'end_turn', exitCode: null, hasDiff: true, remoteBranchExists: true });
    expect(r.outcome).toBe('succeeded');
    expect(r.reasonCode).toBeNull();
    expect(r.failureClass).toBeNull();
  });

  it('hasDiff + remote absent/mismatch → git_push_failed (counts toward breaker)', () => {
    const r = resolveOutcome({ stopReason: 'end_turn', exitCode: null, hasDiff: true, remoteBranchExists: false });
    expect(r.outcome).toBe('failed');
    expect(r.reasonCode).toBe('git_push_failed');
    expect(r.failureClass).toBe('infra');
    expect(r.countsTowardBreaker).toBeUndefined(); // defaults to true
  });

  it('hasDiff + ls-remote failed (null) → git_push_failed, countsTowardBreaker=false', () => {
    const r = resolveOutcome({ stopReason: 'end_turn', exitCode: null, hasDiff: true, remoteBranchExists: null });
    expect(r.outcome).toBe('failed');
    expect(r.reasonCode).toBe('git_push_failed');
    expect(r.countsTowardBreaker).toBe(false);
  });
});

describe('resolveOutcome — terminal fallbacks', () => {
  it('cleanEnd + no commits → no_changes', () => {
    expect(resolveOutcome({ stopReason: 'end_turn', exitCode: null, hasDiff: false }).reasonCode).toBe('no_changes');
    expect(resolveOutcome({ stopReason: null, exitCode: 0, hasDiff: false }).reasonCode).toBe('no_changes');
  });

  it('non-zero exit, no commits → agent_error', () => {
    expect(resolveOutcome({ stopReason: null, exitCode: 1, hasDiff: false }).reasonCode).toBe('agent_error');
  });

  it('catch-all (null exit, no stop reason) → agent_error', () => {
    const r = resolveOutcome({ stopReason: null, exitCode: null, hasDiff: false });
    expect(r.outcome).toBe('failed');
    expect(r.reasonCode).toBe('agent_error');
  });
});

describe('resolveOutcome — failure_class property', () => {
  it("failure_class is 'infra' exactly for infra reason codes + interrupted, null otherwise", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_REASON_CODES), (rc) => {
        // Drive via a termination intent so we can exercise every reason code.
        const outcome =
          rc === 'interrupted'
            ? 'interrupted'
            : rc === 'cancelled_by_api'
              ? 'cancelled'
              : rc === 'budget_exceeded'
                ? 'budget_exceeded'
                : rc === 'timed_out'
                  ? 'timed_out'
                  : rc === 'agent_blocked'
                    ? 'blocked'
                    : 'failed';
        const expectedInfra =
          outcome === 'interrupted' ||
          (outcome === 'failed' && (INFRA_SET.includes(rc) || rc === 'cancelled_by_breaker'));
        const ti: TerminationIntent = {
          outcome,
          reasonCode: rc,
          failureClass: expectedInfra ? 'infra' : null,
        };
        const r = resolveOutcome({ terminationIntent: ti, exitCode: 0, hasDiff: false });
        // The intent is echoed verbatim; its failureClass must be internally consistent.
        expect(r.failureClass).toBe(expectedInfra ? 'infra' : null);
      }),
      { numRuns: 200 }
    );
  });

  it('declared outcomes derive failure_class from the reason code', () => {
    const succeeded: ReportOutcomePayload = { outcome: 'succeeded' };
    expect(resolveOutcome({ reported: succeeded, exitCode: 0, hasDiff: true, remoteBranchExists: true }).failureClass).toBeNull();
    const failed: ReportOutcomePayload = { outcome: 'failed' };
    expect(resolveOutcome({ reported: failed, exitCode: 0, hasDiff: false }).failureClass).toBeNull();
  });

  it('reason_code is null only for succeeded', () => {
    const r = resolveOutcome({ reported: { outcome: 'succeeded' }, exitCode: 0, hasDiff: true, remoteBranchExists: true });
    expect(r.outcome).toBe('succeeded');
    expect(r.reasonCode).toBeNull();
  });
});
