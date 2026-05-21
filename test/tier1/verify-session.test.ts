/**
 * Tier 1 tests: verifySession core.
 *
 * Exercises the verifier against a fake SessionFiles and fake GitHubClient —
 * no daemon, no ACP, no real GitHub.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createVerifier, type VerifyResult } from '../../src/verify-session.js';
import { createLogger } from '../../src/log.js';
import type { SessionFiles, SessionMeta, StreamEntry } from '../../src/session-files.js';
import type { GitHubClient, PullState, MergeResult } from '../../src/github.js';

// --- Fakes ---

interface FakeSessionFilesState {
  metas: Map<string, SessionMeta>;
  streamEntries: Map<string, StreamEntry[]>;
}

function createFakeSessionFiles(): { files: SessionFiles; state: FakeSessionFilesState } {
  const state: FakeSessionFilesState = {
    metas: new Map(),
    streamEntries: new Map(),
  };

  const files: SessionFiles = {
    createSession: () => {
      throw new Error('fake: not implemented');
    },
    appendStream(sessionId, entry) {
      const arr = state.streamEntries.get(sessionId) ?? [];
      arr.push(entry);
      state.streamEntries.set(sessionId, arr);
    },
    appendPrompt: () => {
      throw new Error('fake: not implemented');
    },
    updateMeta(sessionId, patch) {
      const existing = state.metas.get(sessionId);
      if (!existing) throw new Error(`fake: no meta for ${sessionId}`);
      state.metas.set(sessionId, { ...existing, ...patch } as SessionMeta);
    },
    readMeta(sessionId) {
      const meta = state.metas.get(sessionId);
      if (!meta) throw new Error(`fake: no meta for ${sessionId}`);
      return meta;
    },
    listSessions: () => Array.from(state.metas.values()),
    sessionExists: (sessionId) => state.metas.has(sessionId),
  };

  return { files, state };
}

interface FakeGitHubClient extends GitHubClient {
  setState(repo: string, prNumber: number, state: PullState): void;
  failNext(err: Error): void;
  callCount: () => number;
}

function createFakeGitHub(): FakeGitHubClient {
  const states = new Map<string, PullState>();
  let nextError: Error | null = null;
  let calls = 0;

  return {
    setState(repo, prNumber, state) {
      states.set(`${repo}#${prNumber}`, state);
    },
    failNext(err) {
      nextError = err;
    },
    callCount: () => calls,
    async getPullState(owner, repo, prNumber): Promise<PullState> {
      calls++;
      if (nextError !== null) {
        const err = nextError;
        nextError = null;
        throw err;
      }
      const key = `${owner}/${repo}#${prNumber}`;
      const found = states.get(key);
      if (!found) throw new Error(`fake: no state for ${key}`);
      return found;
    },
    async mergePullRequest(): Promise<MergeResult> {
      throw new Error('fake: mergePullRequest not used by verifier tests');
    },
  };
}

function makeMeta(prs: Array<{ repo: string; pr_number: number }>): SessionMeta {
  return {
    session_id: 'sess-1',
    original_prompt: 'test',
    status: 'active',
    created_at: 1700000000,
    completed_at: null,
    prs: prs.map((p) => ({ ...p, registered_at: 1700000000 })),
  };
}

let github: FakeGitHubClient;
let files: SessionFiles;
let state: FakeSessionFilesState;
let verifySession: ReturnType<typeof createVerifier>;

beforeEach(() => {
  github = createFakeGitHub();
  const fake = createFakeSessionFiles();
  files = fake.files;
  state = fake.state;
  verifySession = createVerifier({
    sessionFiles: files,
    github,
    log: createLogger({ level: 'error', output: () => {} }),
  });
});

describe('verifySession', () => {
  describe('terminal write paths', () => {
    it('all PRs merged → writes termination_reason=merged and returns verified:true', async () => {
      state.metas.set('sess-1', makeMeta([{ repo: 'o/r', pr_number: 1 }]));
      github.setState('o/r', 1, { number: 1, state: 'closed', merged: true, mergeCommitSha: 'abc' });

      const result = await verifySession('sess-1');
      expect(result).toEqual({ verified: true, termination_reason: 'merged' });
      expect(state.metas.get('sess-1')!.termination_reason).toBe('merged');
      expect(state.metas.get('sess-1')!.status).toBe('completed');
      expect(state.metas.get('sess-1')!.completed_at).toBeGreaterThan(0);
    });

    it('all PRs closed-unmerged → writes closed_without_merge', async () => {
      state.metas.set('sess-1', makeMeta([{ repo: 'o/r', pr_number: 1 }]));
      github.setState('o/r', 1, { number: 1, state: 'closed', merged: false, mergeCommitSha: null });

      const result = await verifySession('sess-1');
      expect(result).toEqual({ verified: true, termination_reason: 'closed_without_merge' });
    });

    it('mixed (one merged, one closed-unmerged) → closed_without_merge', async () => {
      state.metas.set('sess-1', makeMeta([
        { repo: 'o/r', pr_number: 1 },
        { repo: 'o/r', pr_number: 2 },
      ]));
      github.setState('o/r', 1, { number: 1, state: 'closed', merged: true, mergeCommitSha: 'a' });
      github.setState('o/r', 2, { number: 2, state: 'closed', merged: false, mergeCommitSha: null });

      const result = await verifySession('sess-1');
      expect(result).toEqual({ verified: true, termination_reason: 'closed_without_merge' });
    });

    it('appends session_verified stream entry on terminal write', async () => {
      state.metas.set('sess-1', makeMeta([{ repo: 'o/r', pr_number: 1 }]));
      github.setState('o/r', 1, { number: 1, state: 'closed', merged: true, mergeCommitSha: 'a' });
      await verifySession('sess-1');

      const entries = state.streamEntries.get('sess-1') ?? [];
      const verifiedEntry = entries.find((e) => e['type'] === 'session_verified');
      expect(verifiedEntry).toBeDefined();
      expect(verifiedEntry!['termination_reason']).toBe('merged');
      expect(verifiedEntry!['prs']).toEqual([{ repo: 'o/r', pr_number: 1 }]);
    });
  });

  describe('no-op paths', () => {
    it('any PR still open → no write, returns prs_still_open with the open list', async () => {
      state.metas.set('sess-1', makeMeta([
        { repo: 'o/r', pr_number: 1 },
        { repo: 'o/r', pr_number: 2 },
      ]));
      github.setState('o/r', 1, { number: 1, state: 'open', merged: false, mergeCommitSha: null });
      github.setState('o/r', 2, { number: 2, state: 'closed', merged: true, mergeCommitSha: 'a' });

      const result = await verifySession('sess-1');
      expect(result).toEqual({
        verified: false,
        reason: 'prs_still_open',
        open_prs: [{ repo: 'o/r', pr_number: 1 }],
      });
      expect(state.metas.get('sess-1')!.termination_reason).toBeUndefined();
      expect(state.metas.get('sess-1')!.status).toBe('active');
    });

    it('no registered PRs → no_prs, no write', async () => {
      state.metas.set('sess-1', makeMeta([]));
      const result = await verifySession('sess-1');
      expect(result).toEqual({ verified: false, reason: 'no_prs' });
      expect(state.metas.get('sess-1')!.status).toBe('active');
    });

    it('already verified → already_verified, no double-write', async () => {
      const meta = makeMeta([{ repo: 'o/r', pr_number: 1 }]);
      meta.termination_reason = 'merged';
      meta.status = 'completed';
      state.metas.set('sess-1', meta);

      const result = await verifySession('sess-1');
      expect(result).toEqual({ verified: false, reason: 'already_verified' });
      // No GitHub call should have happened
      expect(github.callCount()).toBe(0);
    });

    it('unknown session → unknown_session, no write, no GitHub call', async () => {
      const result = await verifySession('nope');
      expect(result).toEqual({ verified: false, reason: 'unknown_session' });
      expect(github.callCount()).toBe(0);
    });
  });

  describe('GitHub error path', () => {
    it('GitHub query throws → returns github_error and appends verification_failed stream entry', async () => {
      state.metas.set('sess-1', makeMeta([{ repo: 'o/r', pr_number: 1 }]));
      github.failNext(new Error('boom: network down'));

      const result = await verifySession('sess-1');
      expect(result).toEqual({ verified: false, reason: 'github_error', error: 'boom: network down' });
      expect(state.metas.get('sess-1')!.termination_reason).toBeUndefined();
      expect(state.metas.get('sess-1')!.status).toBe('active');

      const entries = state.streamEntries.get('sess-1') ?? [];
      const failedEntry = entries.find((e) => e['type'] === 'verification_failed');
      expect(failedEntry).toBeDefined();
      expect(failedEntry!['error']).toBe('boom: network down');
    });

    it('does NOT append session_verified on github_error', async () => {
      state.metas.set('sess-1', makeMeta([{ repo: 'o/r', pr_number: 1 }]));
      github.failNext(new Error('500'));
      await verifySession('sess-1');
      const entries = state.streamEntries.get('sess-1') ?? [];
      expect(entries.find((e) => e['type'] === 'session_verified')).toBeUndefined();
    });
  });

  describe('concurrency (single-flight)', () => {
    it('two concurrent calls for the same session produce one write and identical results', async () => {
      state.metas.set('sess-1', makeMeta([{ repo: 'o/r', pr_number: 1 }]));
      github.setState('o/r', 1, { number: 1, state: 'closed', merged: true, mergeCommitSha: 'abc' });

      const [a, b] = await Promise.all([verifySession('sess-1'), verifySession('sess-1')]);
      expect(a).toEqual(b);
      expect(a).toEqual({ verified: true, termination_reason: 'merged' });

      // Only one GitHub call — second invocation joined the in-flight promise
      expect(github.callCount()).toBe(1);

      // Only one session_verified entry
      const entries = state.streamEntries.get('sess-1') ?? [];
      const verifiedEntries = entries.filter((e) => e['type'] === 'session_verified');
      expect(verifiedEntries).toHaveLength(1);
    });

    it('after settlement the in-flight slot is released for the next call', async () => {
      state.metas.set('sess-1', makeMeta([{ repo: 'o/r', pr_number: 1 }]));
      github.setState('o/r', 1, { number: 1, state: 'open', merged: false, mergeCommitSha: null });

      await verifySession('sess-1');
      await verifySession('sess-1');

      // Both calls hit GitHub because neither one was terminal (PR is open)
      // and the in-flight map released between them
      expect(github.callCount()).toBe(2);
    });
  });

  describe('malformed inputs', () => {
    it('skips PRs with malformed repo strings rather than failing', async () => {
      state.metas.set('sess-1', makeMeta([
        { repo: 'no-slash', pr_number: 1 },
        { repo: 'o/r', pr_number: 2 },
      ]));
      github.setState('o/r', 2, { number: 2, state: 'closed', merged: true, mergeCommitSha: 'a' });

      const result = await verifySession('sess-1');
      // The malformed one is skipped; verification proceeds on the well-formed PR
      expect(result).toEqual({ verified: true, termination_reason: 'merged' });
    });
  });
});

// Property assertion: callers can safely await without try/catch
describe('error contract', () => {
  it('returns a VerifyResult union rather than throwing on GitHub errors', async () => {
    state.metas.set('sess-1', makeMeta([{ repo: 'o/r', pr_number: 1 }]));
    github.failNext(new Error('connection refused'));
    const result: VerifyResult = await verifySession('sess-1');
    expect(result.verified).toBe(false);
  });

  it('never throws when meta is missing', async () => {
    await expect(verifySession('nope')).resolves.toBeDefined();
  });
});
