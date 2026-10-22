/**
 * Tier 1 tests: worktree-manager pure functions.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  canonicalClonePath,
  createWorktreeManager,
  sessionWorkDir,
  worktreePath,
} from '../../src/worktree-manager.js';
import type { Logger } from '../../src/log.js';

describe('canonicalClonePath', () => {
  it('constructs path from rootDir, owner, and name', () => {
    expect(canonicalClonePath('/home/user/.agent-router', 'acme', 'widget'))
      .toBe('/home/user/.agent-router/repos/acme/widget');
  });
});

describe('worktreePath', () => {
  it('joins the worktree base and sessionId', () => {
    const sid = 'abc-123-def';
    expect(worktreePath('/srv/agent-router/worktrees', sid))
      .toBe('/srv/agent-router/worktrees/abc-123-def');
  });
});

describe('sessionWorkDir', () => {
  it('is <base>/<sid>/work in the isolation model', () => {
    expect(sessionWorkDir('/srv/wt', 'sid-1', true)).toBe('/srv/wt/sid-1/work');
  });

  it('is <base>/<sid> (the git worktree) in the non-isolation model', () => {
    expect(sessionWorkDir('/srv/wt', 'sid-1', false)).toBe('/srv/wt/sid-1');
  });
});

describe('canonical clone refresh', () => {
  it('fetches remote heads with an explicit refspec and no --prune', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtm-'));
    const cloneDir = canonicalClonePath(rootDir, 'acme', 'widget');
    fs.mkdirSync(cloneDir, { recursive: true });
    fs.writeFileSync(path.join(cloneDir, 'HEAD'), 'ref: refs/heads/main\n');

    const calls: string[][] = [];
    const run = ((_cmd: string, args: readonly string[]) => {
      calls.push([...args]);
      return args.includes('symbolic-ref') ? 'refs/heads/main\n' : '';
    }) as unknown as typeof import('node:child_process').execFileSync;
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

    try {
      const mgr = createWorktreeManager({ rootDir, log, useWorkerUid: false, execFileSyncImpl: run });
      const workdir = mgr.ensureWorktree('acme/widget', 'sid-1');

      const fetchCall = calls.find((a) => a[0] === 'fetch');
      expect(fetchCall).toEqual(['fetch', 'origin', '+refs/heads/*:refs/heads/*']);
      expect(workdir).toBe(sessionWorkDir(path.join(rootDir, 'worktrees'), 'sid-1', false));
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
