/**
 * Tier 1: Unit tests for read_repos parsing from session prompts.
 *
 * Tests the pure functions exported from session-mgr.ts:
 * - extractFrontmatter
 * - parseReadReposFromFrontmatter
 * - parseReadReposFromPrompt
 * - resolveReadRepos
 *
 * Feature: auth-credential-proxy, Task 11.3 — read_repos parsing edge cases
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  extractFrontmatter,
  parseReadReposFromFrontmatter,
  parseReadReposFromPrompt,
  resolveReadRepos,
} from '../../src/session-mgr.js';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a valid repo segment (owner or repo part) */
const arbRepoSegment = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'.split('')),
  { minLength: 1, maxLength: 20 },
);

/** Generate a valid repo string: owner/repo */
const arbValidRepo = fc.tuple(arbRepoSegment, arbRepoSegment).map(([a, b]) => `${a}/${b}`);

// ---------------------------------------------------------------------------
// extractFrontmatter
// ---------------------------------------------------------------------------

describe('extractFrontmatter', () => {
  it('extracts frontmatter from a prompt with valid delimiters', () => {
    const prompt = '---\nread_repos:\n  - owner/repo\n---\nHello world';
    expect(extractFrontmatter(prompt)).toBe('read_repos:\n  - owner/repo');
  });

  it('returns undefined when prompt does not start with ---', () => {
    const prompt = 'Hello world\n---\nfoo: bar\n---\n';
    expect(extractFrontmatter(prompt)).toBeUndefined();
  });

  it('returns undefined when there is no closing ---', () => {
    const prompt = '---\nfoo: bar\nno closing delimiter';
    expect(extractFrontmatter(prompt)).toBeUndefined();
  });

  it('returns undefined for a single --- with no newline', () => {
    const prompt = '---';
    expect(extractFrontmatter(prompt)).toBeUndefined();
  });

  it('returns empty string for empty frontmatter (--- immediately followed by ---)', () => {
    const prompt = '---\n---\nBody text';
    expect(extractFrontmatter(prompt)).toBe('');
  });

  it('handles frontmatter with trailing whitespace on delimiter lines', () => {
    const prompt = '---  \nkey: value\n---  \nBody';
    expect(extractFrontmatter(prompt)).toBe('key: value');
  });

  it('handles multiple --- in the prompt (uses first closing)', () => {
    const prompt = '---\nfoo: bar\n---\nbody\n---\nmore';
    expect(extractFrontmatter(prompt)).toBe('foo: bar');
  });

  it('handles frontmatter with blank lines inside', () => {
    const prompt = '---\nfoo: bar\n\nbaz: qux\n---\nbody';
    expect(extractFrontmatter(prompt)).toBe('foo: bar\n\nbaz: qux');
  });

  it('returns undefined when first line has extra chars after ---', () => {
    const prompt = '--- yaml\nfoo: bar\n---\nbody';
    expect(extractFrontmatter(prompt)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseReadReposFromFrontmatter
// ---------------------------------------------------------------------------

describe('parseReadReposFromFrontmatter', () => {
  it('parses a simple YAML list of repos', () => {
    const fm = 'read_repos:\n  - owner/repo-a\n  - org/repo-b';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual(['owner/repo-a', 'org/repo-b']);
    expect(result.invalid).toEqual([]);
  });

  it('parses inline flow syntax: read_repos: [a/b, c/d]', () => {
    const fm = 'read_repos: [owner/repo-a, org/repo-b]';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual(['owner/repo-a', 'org/repo-b']);
    expect(result.invalid).toEqual([]);
  });

  it('parses a single value after key: read_repos: owner/repo', () => {
    const fm = 'read_repos: owner/repo';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual(['owner/repo']);
    expect(result.invalid).toEqual([]);
  });

  it('returns empty repos when read_repos key is not present', () => {
    const fm = 'project: my-project\nother_key: value';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it('captures invalid entries in the invalid array', () => {
    const fm = 'read_repos:\n  - owner/repo\n  - not-a-repo\n  - another/valid';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual(['owner/repo', 'another/valid']);
    expect(result.invalid).toEqual(['not-a-repo']);
  });

  it('handles invalid entries in inline flow syntax', () => {
    const fm = 'read_repos: [good/repo, bad repo, ok/repo]';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual(['good/repo', 'ok/repo']);
    expect(result.invalid).toEqual(['bad repo']);
  });

  it('stops parsing read_repos list at next top-level key', () => {
    const fm = 'read_repos:\n  - owner/repo\nproject: foo\n  - should/not-be-parsed';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual(['owner/repo']);
  });

  it('handles empty read_repos list (key present, no items)', () => {
    const fm = 'read_repos:\nproject: foo';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual([]);
  });

  it('handles read_repos with extra spaces in list items', () => {
    const fm = 'read_repos:\n  -   owner/repo  ';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual(['owner/repo']);
  });

  it('handles blank lines between list items', () => {
    const fm = 'read_repos:\n  - owner/repo-a\n\n  - owner/repo-b';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual(['owner/repo-a', 'owner/repo-b']);
  });

  it('ignores other keys and only extracts read_repos', () => {
    const fm = 'project: my-project\nread_repos:\n  - owner/repo\ntimeout: 30';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual(['owner/repo']);
  });

  it('rejects repos with special characters', () => {
    const fm = 'read_repos:\n  - owner/repo\n  - owner/repo with spaces\n  - owner/repo@v2';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual(['owner/repo']);
    expect(result.invalid).toEqual(['owner/repo with spaces', 'owner/repo@v2']);
  });

  it('handles empty inline flow array', () => {
    const fm = 'read_repos: []';
    const result = parseReadReposFromFrontmatter(fm);
    expect(result.repos).toEqual([]);
    expect(result.invalid).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseReadReposFromPrompt
// ---------------------------------------------------------------------------

describe('parseReadReposFromPrompt', () => {
  it('extracts read_repos from a complete prompt with frontmatter', () => {
    const prompt = '---\nread_repos:\n  - owner/repo\n---\nFix the bug in repo';
    const result = parseReadReposFromPrompt(prompt);
    expect(result.repos).toEqual(['owner/repo']);
  });

  it('returns empty when prompt has no frontmatter', () => {
    const prompt = 'Just a plain prompt with no frontmatter';
    const result = parseReadReposFromPrompt(prompt);
    expect(result.repos).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it('returns empty when frontmatter has no read_repos key', () => {
    const prompt = '---\nproject: my-project\n---\nDo some work';
    const result = parseReadReposFromPrompt(prompt);
    expect(result.repos).toEqual([]);
  });

  it('handles multiple repos in frontmatter', () => {
    const prompt = '---\nread_repos:\n  - org/repo-a\n  - org/repo-b\n  - org/repo-c\n---\nAnalyze all repos';
    const result = parseReadReposFromPrompt(prompt);
    expect(result.repos).toEqual(['org/repo-a', 'org/repo-b', 'org/repo-c']);
  });

  it('handles prompt that is just frontmatter with no body', () => {
    const prompt = '---\nread_repos:\n  - owner/repo\n---';
    const result = parseReadReposFromPrompt(prompt);
    expect(result.repos).toEqual(['owner/repo']);
  });

  it('returns empty for prompt starting with --- but invalid frontmatter', () => {
    const prompt = '---\nincomplete frontmatter without closing';
    const result = parseReadReposFromPrompt(prompt);
    expect(result.repos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveReadRepos
// ---------------------------------------------------------------------------

describe('resolveReadRepos', () => {
  it('prioritizes explicit parameter over frontmatter', () => {
    const prompt = '---\nread_repos:\n  - frontmatter/repo\n---\nbody';
    const result = resolveReadRepos(prompt, ['explicit/repo']);
    expect(result.repos).toEqual(['explicit/repo']);
  });

  it('falls back to frontmatter when explicit parameter is undefined', () => {
    const prompt = '---\nread_repos:\n  - frontmatter/repo\n---\nbody';
    const result = resolveReadRepos(prompt, undefined);
    expect(result.repos).toEqual(['frontmatter/repo']);
  });

  it('falls back to frontmatter when explicit parameter is empty array', () => {
    const prompt = '---\nread_repos:\n  - frontmatter/repo\n---\nbody';
    const result = resolveReadRepos(prompt, []);
    expect(result.repos).toEqual(['frontmatter/repo']);
  });

  it('validates explicit parameter entries', () => {
    const result = resolveReadRepos('plain prompt', ['good/repo', 'bad repo', 'ok/valid']);
    expect(result.repos).toEqual(['good/repo', 'ok/valid']);
    expect(result.invalid).toEqual(['bad repo']);
  });

  it('returns empty when no explicit param and no frontmatter', () => {
    const result = resolveReadRepos('no frontmatter here');
    expect(result.repos).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it('returns empty when explicit param is undefined and frontmatter has no read_repos', () => {
    const prompt = '---\nproject: foo\n---\nbody';
    const result = resolveReadRepos(prompt, undefined);
    expect(result.repos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('read_repos parsing properties', () => {
  it('round-trip: repos in list-style frontmatter are all parsed back', () => {
    fc.assert(
      fc.property(
        fc.array(arbValidRepo, { minLength: 0, maxLength: 10 }),
        (repos) => {
          const items = repos.map((r) => `  - ${r}`).join('\n');
          const prompt = `---\nread_repos:\n${items}\n---\nbody`;
          const result = parseReadReposFromPrompt(prompt);
          expect(result.repos).toEqual(repos);
          expect(result.invalid).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('explicit repos always override frontmatter', () => {
    fc.assert(
      fc.property(
        fc.array(arbValidRepo, { minLength: 1, maxLength: 10 }),
        (explicitRepos) => {
          const prompt = '---\nread_repos:\n  - frontmatter/override-me\n---\nbody';
          const result = resolveReadRepos(prompt, explicitRepos);
          expect(result.repos).toEqual(explicitRepos);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('inline flow syntax round-trip', () => {
    fc.assert(
      fc.property(
        fc.array(arbValidRepo, { minLength: 0, maxLength: 10 }),
        (repos) => {
          const fm = `read_repos: [${repos.join(', ')}]`;
          const result = parseReadReposFromFrontmatter(fm);
          expect(result.repos).toEqual(repos);
          expect(result.invalid).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('never throws on arbitrary input to parseReadReposFromPrompt', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (input) => {
          const result = parseReadReposFromPrompt(input);
          expect(result.repos).toBeInstanceOf(Array);
          expect(result.invalid).toBeInstanceOf(Array);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('resolveReadRepos never throws on arbitrary explicit repos', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 0, maxLength: 50 }), { minLength: 0, maxLength: 10 }),
        (repos) => {
          const result = resolveReadRepos('no frontmatter', repos);
          expect(result.repos).toBeInstanceOf(Array);
          expect(result.invalid).toBeInstanceOf(Array);
          // Every result repo should be valid format
          for (const r of result.repos) {
            expect(r).toMatch(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
