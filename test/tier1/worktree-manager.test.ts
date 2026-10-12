/**
 * Tier 1 tests: worktree-manager pure functions.
 */
import { describe, it, expect } from 'vitest';
import { canonicalClonePath, worktreePath } from '../../src/worktree-manager.js';

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
