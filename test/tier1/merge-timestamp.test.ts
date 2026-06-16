import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { selectVisibleSessions, DEFAULT_LS_LIMIT } from '../../src/ls-pagination.js';
import { createVerifier } from '../../src/verify-session.js';
import { createLogger } from '../../src/log.js';
import type { GitHubClient } from '../../src/github.js';

let tmpDir: string;
let sf: SessionFiles;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-timestamp-test-'));
  sf = createSessionFiles(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('merged_at in SessionMeta.prs[]', () => {
  it('prs[] entries start without merged_at', () => {
    sf.createSession('s1', 'test');
    const prs = [{ repo: 'owner/repo', pr_number: 1, registered_at: 1000 }];
    sf.updateMeta('s1', { prs });
    const meta = sf.readMeta('s1');
    expect(meta.prs[0]!.merged_at).toBeUndefined();
  });

  it('merged_at can be set on a PR entry', () => {
    sf.createSession('s2', 'test');
    const prs = [{ repo: 'owner/repo', pr_number: 1, registered_at: 1000, merged_at: 2000 }];
    sf.updateMeta('s2', { prs });
    const meta = sf.readMeta('s2');
    expect(meta.prs[0]!.merged_at).toBe(2000);
  });

  it('merged_at persists through JSON round-trip', () => {
    sf.createSession('s3', 'test');
    const prs = [
      { repo: 'a/b', pr_number: 10, registered_at: 100, merged_at: 200 },
      { repo: 'c/d', pr_number: 20, registered_at: 300 },
    ];
    sf.updateMeta('s3', { prs });
    const raw = fs.readFileSync(
      path.join(tmpDir, 'sessions', 's3', 'meta.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw);
    expect(parsed.prs[0].merged_at).toBe(200);
    expect(parsed.prs[1].merged_at).toBeUndefined();
  });
});

describe('verifySession sets merged_at', () => {
  it('sets merged_at on all PRs when all are merged', async () => {
    sf.createSession('v1', 'test');
    sf.updateMeta('v1', {
      prs: [
        { repo: 'owner/repo', pr_number: 1, registered_at: 1000 },
        { repo: 'owner/repo', pr_number: 2, registered_at: 1100 },
      ],
    });

    const fakeGithub: GitHubClient = {
      getPullState: async (_o, _r, prNumber) => ({ number: prNumber, state: 'closed', merged: true, mergeCommitSha: 'abc123', headSha: null }),
      mergePullRequest: async () => ({ sha: 'abc', merged: true, message: 'ok' }),
      getCheckRunsForRef: async () => [],
    };

    const log = createLogger({ level: 'error', output: () => {} });
    const verify = createVerifier({ sessionFiles: sf, github: fakeGithub, log });

    const result = await verify('v1');
    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.termination_reason).toBe('merged');
    }

    const meta = sf.readMeta('v1');
    expect(meta.prs[0]!.merged_at).toBeDefined();
    expect(typeof meta.prs[0]!.merged_at).toBe('number');
    expect(meta.prs[1]!.merged_at).toBeDefined();
    expect(meta.prs[0]!.merged_at).toBe(meta.prs[1]!.merged_at);
  });

  it('does not set merged_at when PRs are closed without merge', async () => {
    sf.createSession('v2', 'test');
    sf.updateMeta('v2', {
      prs: [{ repo: 'owner/repo', pr_number: 3, registered_at: 1000 }],
    });

    const fakeGithub: GitHubClient = {
      getPullState: async (_o, _r, prNumber) => ({ number: prNumber, state: 'closed', merged: false, mergeCommitSha: null, headSha: null }),
      mergePullRequest: async () => ({ sha: 'abc', merged: true, message: 'ok' }),
      getCheckRunsForRef: async () => [],
    };

    const log = createLogger({ level: 'error', output: () => {} });
    const verify = createVerifier({ sessionFiles: sf, github: fakeGithub, log });

    const result = await verify('v2');
    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.termination_reason).toBe('closed_without_merge');
    }

    const meta = sf.readMeta('v2');
    expect(meta.prs[0]!.merged_at).toBeUndefined();
  });
});

describe('selectVisibleSessions --merged filter', () => {
  function makeSession(id: string, status: string, prs?: Array<{ merged_at?: number }>) {
    return { session_id: id, status, prs: prs ?? [] };
  }

  it('returns only sessions with at least one merged PR', () => {
    const sessions = [
      makeSession('a', 'completed', [{ merged_at: 100 }]),
      makeSession('b', 'completed', []),
      makeSession('c', 'completed', [{ merged_at: 200 }]),
      makeSession('d', 'failed', []),
    ];
    const result = selectVisibleSessions(sessions, { all: true, limit: DEFAULT_LS_LIMIT, merged: true });
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.session_id)).toEqual(['a', 'c']);
  });

  it('returns empty when no sessions have merged PRs', () => {
    const sessions = [
      makeSession('x', 'completed', []),
      makeSession('y', 'failed', [{}]),
    ];
    const result = selectVisibleSessions(sessions, { all: true, limit: DEFAULT_LS_LIMIT, merged: true });
    expect(result).toHaveLength(0);
  });

  it('merged filter applies before pagination cap', () => {
    const sessions = [
      makeSession('a', 'completed', [{ merged_at: 1 }]),
      makeSession('b', 'completed', [{ merged_at: 2 }]),
      makeSession('c', 'completed', [{ merged_at: 3 }]),
    ];
    const result = selectVisibleSessions(sessions, { all: false, limit: 2, merged: true });
    expect(result).toHaveLength(2);
  });

  it('without --merged flag, sessions without merged PRs are still shown', () => {
    const sessions = [
      makeSession('a', 'completed', []),
      makeSession('b', 'completed', [{ merged_at: 100 }]),
    ];
    const result = selectVisibleSessions(sessions, { all: true, limit: DEFAULT_LS_LIMIT });
    expect(result).toHaveLength(2);
  });

  it('merged filter with active sessions still includes active', () => {
    const sessions = [
      makeSession('a', 'active', [{ merged_at: 1 }]),
      makeSession('b', 'completed', [{ merged_at: 2 }]),
      makeSession('c', 'completed', []),
    ];
    const result = selectVisibleSessions(sessions, { all: false, limit: 10, merged: true });
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.session_id)).toEqual(['a', 'b']);
  });
});
