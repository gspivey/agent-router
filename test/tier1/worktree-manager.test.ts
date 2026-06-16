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
  it('constructs path from rootDir and sessionId', () => {
    const sid = 'abc-123-def';
    expect(worktreePath('/home/user/.agent-router', sid))
      .toBe('/home/user/.agent-router/worktrees/abc-123-def');
  });
});
