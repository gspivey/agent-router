import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { groupSessionsByRepo, validatePerRepoLimit } from '../../../src/web-routes.js';
import type { SessionMeta } from '../../../src/session-files.js';
import type { RepoConfig, CronConfig } from '../../../src/config.js';
import type { CronState } from '../../../src/db.js';

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: crypto.randomUUID(),
    original_prompt: 'test',
    status: 'completed',
    created_at: Math.floor(Date.now() / 1000),
    completed_at: null,
    prs: [],
    ...overrides,
  };
}

const noWaiting = () => undefined;
const fixedNow = new Date('2026-08-23T12:00:00Z');

describe('groupSessionsByRepo', () => {
  const repos: RepoConfig[] = [
    { owner: 'org', name: 'repo-a' },
    { owner: 'org', name: 'repo-b' },
  ];

  it('produces one group per configured repo even with no sessions', () => {
    const result = groupSessionsByRepo([], repos, [], [], 5, noWaiting, fixedNow);
    expect(result.length).toBe(2);
    expect(result[0]!.repo).toBe('org/repo-a');
    expect(result[1]!.repo).toBe('org/repo-b');
    expect(result[0]!.active_sessions).toEqual([]);
    expect(result[0]!.terminal_sessions).toEqual([]);
    expect(result[0]!.terminal_total).toBe(0);
  });

  it('splits sessions into active and terminal correctly', () => {
    const sessions = [
      makeMeta({ repo: 'org/repo-a', status: 'active', created_at: 100 }),
      makeMeta({ repo: 'org/repo-a', status: 'completed', created_at: 90 }),
      makeMeta({ repo: 'org/repo-a', status: 'failed', created_at: 80 }),
    ];
    const result = groupSessionsByRepo(sessions, repos, [], [], 5, noWaiting, fixedNow);
    const group = result[0]!;
    expect(group.active_sessions.length).toBe(1);
    expect(group.terminal_sessions.length).toBe(2);
    expect(group.terminal_total).toBe(2);
  });

  it('sorts terminal sessions by created_at descending', () => {
    const sessions = [
      makeMeta({ repo: 'org/repo-a', status: 'completed', created_at: 50 }),
      makeMeta({ repo: 'org/repo-a', status: 'completed', created_at: 100 }),
      makeMeta({ repo: 'org/repo-a', status: 'completed', created_at: 75 }),
    ];
    const result = groupSessionsByRepo(sessions, repos, [], [], 5, noWaiting, fixedNow);
    const terminal = result[0]!.terminal_sessions;
    expect(terminal[0]!.created_at).toBe(100);
    expect(terminal[1]!.created_at).toBe(75);
    expect(terminal[2]!.created_at).toBe(50);
  });

  it('respects perRepoLimit for terminal sessions', () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      makeMeta({ repo: 'org/repo-a', status: 'completed', created_at: 100 - i }),
    );
    const result = groupSessionsByRepo(sessions, repos, [], [], 3, noWaiting, fixedNow);
    const group = result[0]!;
    expect(group.terminal_sessions.length).toBe(3);
    expect(group.terminal_total).toBe(10);
  });

  it('ignores sessions with no repo', () => {
    const sessions = [
      makeMeta({ status: 'completed', created_at: 100 }),
      makeMeta({ repo: 'org/repo-a', status: 'completed', created_at: 90 }),
    ];
    const result = groupSessionsByRepo(sessions, repos, [], [], 5, noWaiting, fixedNow);
    expect(result[0]!.terminal_total).toBe(1);
  });

  it('enriches with cron state and next_fire', () => {
    const cronEntries: CronConfig[] = [
      { name: 'nightly', schedule: '0 3 * * *', repo: 'org/repo-a', promptFile: '/tmp/p.md' },
    ];
    const cronStates: CronState[] = [];
    const result = groupSessionsByRepo([], repos, cronEntries, cronStates, 5, noWaiting, fixedNow);
    const group = result[0]!;
    expect(group.cron).not.toBeNull();
    expect(group.cron!.name).toBe('nightly');
    expect(group.cron!.schedule).toBe('0 3 * * *');
    expect(group.cron!.paused).toBe(false);
    expect(group.cron!.next_fire).not.toBeNull();
  });

  it('shows paused cron with no next_fire', () => {
    const cronEntries: CronConfig[] = [
      { name: 'nightly', schedule: '0 3 * * *', repo: 'org/repo-a', promptFile: '/tmp/p.md' },
    ];
    const cronStates: CronState[] = [{ name: 'nightly', paused: true, updatedAt: 1000 }];
    const result = groupSessionsByRepo([], repos, cronEntries, cronStates, 5, noWaiting, fixedNow);
    const group = result[0]!;
    expect(group.cron!.paused).toBe(true);
    expect(group.cron!.next_fire).toBeNull();
  });

  it('returns null cron when no cron entry matches repo', () => {
    const cronEntries: CronConfig[] = [
      { name: 'nightly', schedule: '0 3 * * *', repo: 'org/repo-b', promptFile: '/tmp/p.md' },
    ];
    const result = groupSessionsByRepo([], repos, cronEntries, [], 5, noWaiting, fixedNow);
    expect(result[0]!.cron).toBeNull(); // repo-a has no cron
    expect(result[1]!.cron).not.toBeNull(); // repo-b has one
  });

  it('computes open PR count (active session + no merged_at) and closed PR count (terminal session or merged_at set)', () => {
    const sessions = [
      makeMeta({
        repo: 'org/repo-a',
        status: 'active',
        prs: [
          { repo: 'org/repo-a', pr_number: 1, registered_at: 100 },
          { repo: 'org/repo-a', pr_number: 2, registered_at: 100, merged_at: 200 },
        ],
      }),
      makeMeta({
        repo: 'org/repo-a',
        status: 'completed',
        prs: [
          { repo: 'org/repo-a', pr_number: 3, registered_at: 50 },
        ],
      }),
    ];
    const result = groupSessionsByRepo(sessions, repos, [], [], 5, noWaiting, fixedNow);
    // PR #1: active session, no merged_at → open
    // PR #2: active session but merged_at set → closed
    // PR #3: completed session → closed (regardless of merged_at)
    expect(result[0]!.open_pr_count).toBe(1);
    expect(result[0]!.closed_pr_count).toBe(2);
  });

  it('deduplicates PRs across sessions', () => {
    const sessions = [
      makeMeta({
        repo: 'org/repo-a',
        status: 'active',
        prs: [{ repo: 'org/repo-a', pr_number: 1, registered_at: 100 }],
      }),
      makeMeta({
        repo: 'org/repo-a',
        status: 'completed',
        prs: [{ repo: 'org/repo-a', pr_number: 1, registered_at: 50 }], // same PR
      }),
    ];
    const result = groupSessionsByRepo(sessions, repos, [], [], 5, noWaiting, fixedNow);
    // PR #1 seen first on active session → open; second occurrence (completed) is deduped
    expect(result[0]!.open_pr_count).toBe(1);
    expect(result[0]!.closed_pr_count).toBe(0);
  });

  it('includes waiting_for from waitingForFn for active sessions', () => {
    const sessions = [
      makeMeta({ repo: 'org/repo-a', status: 'active', session_id: 'active-1' }),
    ];
    const waitFn = (m: SessionMeta) => m.status === 'active' ? 'tool_call' : undefined;
    const result = groupSessionsByRepo(sessions, repos, [], [], 5, waitFn, fixedNow);
    expect(result[0]!.active_sessions[0]!.waiting_for).toBe('tool_call');
  });

  it('property: total groups equals number of configured repos', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            owner: fc.constant('org'),
            name: fc.stringMatching(/^[a-z]{3,8}$/),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (repoConfigs) => {
          const uniqueRepos = [...new Map(repoConfigs.map(r => [`${r.owner}/${r.name}`, r])).values()];
          const result = groupSessionsByRepo([], uniqueRepos, [], [], 5, noWaiting, fixedNow);
          expect(result.length).toBe(uniqueRepos.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: active + terminal_total equals total sessions for each repo', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            session_id: fc.uuid(),
            original_prompt: fc.constant('test'),
            status: fc.constantFrom('active' as const, 'completed' as const, 'failed' as const, 'abandoned' as const),
            created_at: fc.integer({ min: 1, max: 2000000000 }),
            completed_at: fc.constant(null),
            prs: fc.constant([]),
            repo: fc.constantFrom('org/repo-a', 'org/repo-b'),
          }),
          { maxLength: 30 },
        ),
        (sessions) => {
          const result = groupSessionsByRepo(
            sessions as SessionMeta[],
            repos,
            [],
            [],
            50,
            noWaiting,
            fixedNow,
          );
          for (const group of result) {
            const totalForRepo = sessions.filter(s => s.repo === group.repo).length;
            expect(group.active_sessions.length + group.terminal_total).toBe(totalForRepo);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: terminal_sessions.length <= perRepoLimit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.array(
          fc.record({
            session_id: fc.uuid(),
            original_prompt: fc.constant('test'),
            status: fc.constantFrom('completed' as const, 'failed' as const, 'abandoned' as const),
            created_at: fc.integer({ min: 1, max: 2000000000 }),
            completed_at: fc.constant(null),
            prs: fc.constant([]),
            repo: fc.constant('org/repo-a'),
          }),
          { maxLength: 30 },
        ),
        (perLimit, sessions) => {
          const result = groupSessionsByRepo(
            sessions as SessionMeta[],
            repos,
            [],
            [],
            perLimit,
            noWaiting,
            fixedNow,
          );
          for (const group of result) {
            expect(group.terminal_sessions.length).toBeLessThanOrEqual(perLimit);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('validatePerRepoLimit', () => {
  it('accepts integers 1-50', () => {
    expect(validatePerRepoLimit('1')).toBe(1);
    expect(validatePerRepoLimit('25')).toBe(25);
    expect(validatePerRepoLimit('50')).toBe(50);
  });

  it('rejects invalid values', () => {
    expect(validatePerRepoLimit('0')).toBeNull();
    expect(validatePerRepoLimit('51')).toBeNull();
    expect(validatePerRepoLimit('-1')).toBeNull();
    expect(validatePerRepoLimit('abc')).toBeNull();
    expect(validatePerRepoLimit('1.5')).toBeNull();
  });

  it('property: valid range always accepted', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        expect(validatePerRepoLimit(String(n))).toBe(n);
      }),
      { numRuns: 100 },
    );
  });
});
