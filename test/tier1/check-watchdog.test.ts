import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { nudgeKey, allTerminal, summarizeConclusion } from '../../src/check-watchdog.js';
import type { CheckRunSummary } from '../../src/github.js';

describe('nudgeKey', () => {
  it('returns a stable key for the same inputs', () => {
    expect(nudgeKey(42, 'abc123', 'success')).toBe('42:abc123:success');
    expect(nudgeKey(42, 'abc123', 'success')).toBe('42:abc123:success');
  });

  it('changes when head sha changes (new push)', () => {
    const k1 = nudgeKey(1, 'sha-old', 'success');
    const k2 = nudgeKey(1, 'sha-new', 'success');
    expect(k1).not.toBe(k2);
  });

  it('changes when conclusion changes', () => {
    const k1 = nudgeKey(1, 'sha1', 'success');
    const k2 = nudgeKey(1, 'sha1', 'failure');
    expect(k1).not.toBe(k2);
  });

  it('changes when PR number changes', () => {
    const k1 = nudgeKey(1, 'sha1', 'success');
    const k2 = nudgeKey(2, 'sha1', 'success');
    expect(k1).not.toBe(k2);
  });

  it('property: key is deterministic', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.hexaString({ minLength: 7, maxLength: 40 }),
        fc.constantFrom('success', 'failure', 'cancelled'),
        (pr, sha, conclusion) => {
          return nudgeKey(pr, sha, conclusion) === nudgeKey(pr, sha, conclusion);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: different inputs produce different keys', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.hexaString({ minLength: 7, maxLength: 40 }),
        fc.hexaString({ minLength: 7, maxLength: 40 }),
        fc.constantFrom('success', 'failure'),
        (pr, sha1, sha2, conclusion) => {
          if (sha1 === sha2) return true; // skip identical inputs
          return nudgeKey(pr, sha1, conclusion) !== nudgeKey(pr, sha2, conclusion);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('allTerminal', () => {
  it('returns false for empty array (no checks have run)', () => {
    expect(allTerminal([])).toBe(false);
  });

  it('returns true when all checks are completed', () => {
    const runs: CheckRunSummary[] = [
      { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'test', status: 'completed', conclusion: 'failure' },
    ];
    expect(allTerminal(runs)).toBe(true);
  });

  it('returns false when any check is in_progress', () => {
    const runs: CheckRunSummary[] = [
      { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'test', status: 'in_progress', conclusion: null },
    ];
    expect(allTerminal(runs)).toBe(false);
  });

  it('returns false when any check is queued', () => {
    const runs: CheckRunSummary[] = [
      { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'test', status: 'queued', conclusion: null },
    ];
    expect(allTerminal(runs)).toBe(false);
  });

  it('property: terminal iff all completed', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.nat(),
            name: fc.string({ minLength: 1, maxLength: 20 }),
            status: fc.constantFrom('queued', 'in_progress', 'completed') as fc.Arbitrary<'queued' | 'in_progress' | 'completed'>,
            conclusion: fc.constantFrom('success', 'failure', null) as fc.Arbitrary<string | null>,
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (runs) => {
          const expected = runs.every((r) => r.status === 'completed');
          return allTerminal(runs) === expected;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('summarizeConclusion', () => {
  it('returns success when all checks pass or are skipped', () => {
    const runs: CheckRunSummary[] = [
      { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'skip', status: 'completed', conclusion: 'skipped' },
    ];
    expect(summarizeConclusion(runs)).toBe('success');
  });

  it('returns failure when any check has a non-success/skipped conclusion', () => {
    const runs: CheckRunSummary[] = [
      { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'test', status: 'completed', conclusion: 'failure' },
    ];
    expect(summarizeConclusion(runs)).toBe('failure');
  });

  it('returns failure for cancelled checks', () => {
    const runs: CheckRunSummary[] = [
      { id: 1, name: 'test', status: 'completed', conclusion: 'cancelled' },
    ];
    expect(summarizeConclusion(runs)).toBe('failure');
  });
});
