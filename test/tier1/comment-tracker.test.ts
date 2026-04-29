/**
 * Tier 1 tests: Comment tracker — parse outbound comment IDs from tool output.
 *
 * Tests parseCommentUrl, parseCommentJson, isCommentCommand, extractCommentIds
 * as pure functions with no external dependencies.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  parseCommentUrl,
  parseCommentJson,
  isCommentCommand,
  extractCommentIds,
} from '../../src/comment-tracker.js';

// ---------------------------------------------------------------------------
// parseCommentUrl
// ---------------------------------------------------------------------------

describe('parseCommentUrl', () => {
  it('parses a pull request comment URL', () => {
    const url = 'https://github.com/owner/repo/pull/42#issuecomment-1234567890';
    expect(parseCommentUrl(url)).toEqual({
      commentId: 1234567890,
      repo: 'owner/repo',
      prNumber: 42,
    });
  });

  it('parses an issues comment URL', () => {
    const url = 'https://github.com/myorg/myrepo/issues/7#issuecomment-9876543210';
    expect(parseCommentUrl(url)).toEqual({
      commentId: 9876543210,
      repo: 'myorg/myrepo',
      prNumber: 7,
    });
  });

  it('parses URL embedded in surrounding text', () => {
    const text = 'Comment posted: https://github.com/a/b/pull/1#issuecomment-111 done.';
    expect(parseCommentUrl(text)).toEqual({
      commentId: 111,
      repo: 'a/b',
      prNumber: 1,
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseCommentUrl('https://example.com/pull/1#issuecomment-123')).toBeNull();
  });

  it('returns null for URLs without issuecomment fragment', () => {
    expect(parseCommentUrl('https://github.com/a/b/pull/1')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCommentUrl('')).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(parseCommentUrl('no url here')).toBeNull();
  });

  // Property: any valid URL with the right shape parses correctly
  it('round-trips valid comment URLs (property)', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9-]*$/),
        fc.stringMatching(/^[a-z][a-z0-9-]*$/),
        fc.nat({ max: 99999 }).filter((n) => n > 0),
        fc.nat({ max: 999999999 }).filter((n) => n > 0),
        (owner, repo, pr, commentId) => {
          const url = `https://github.com/${owner}/${repo}/pull/${pr}#issuecomment-${commentId}`;
          const result = parseCommentUrl(url);
          expect(result).not.toBeNull();
          expect(result!.commentId).toBe(commentId);
          expect(result!.prNumber).toBe(pr);
          expect(result!.repo).toBe(`${owner}/${repo}`);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// parseCommentJson
// ---------------------------------------------------------------------------

describe('parseCommentJson', () => {
  it('extracts id from a JSON object', () => {
    const json = JSON.stringify({ id: 42, body: 'hello', url: 'https://...' });
    expect(parseCommentJson(json)).toBe(42);
  });

  it('extracts id from JSON embedded in text', () => {
    const text = 'Response: {"id": 999, "node_id": "abc"}';
    expect(parseCommentJson(text)).toBe(999);
  });

  it('returns null for JSON without id field', () => {
    expect(parseCommentJson('{"body": "hello"}')).toBeNull();
  });

  it('returns null for JSON with non-integer id', () => {
    expect(parseCommentJson('{"id": 1.5}')).toBeNull();
  });

  it('returns null for JSON with zero id', () => {
    expect(parseCommentJson('{"id": 0}')).toBeNull();
  });

  it('returns null for JSON with negative id', () => {
    expect(parseCommentJson('{"id": -1}')).toBeNull();
  });

  it('returns null for JSON with string id', () => {
    expect(parseCommentJson('{"id": "abc"}')).toBeNull();
  });

  it('returns null for non-JSON text', () => {
    expect(parseCommentJson('not json at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCommentJson('')).toBeNull();
  });

  it('returns null for array JSON', () => {
    expect(parseCommentJson('[{"id": 1}]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isCommentCommand
// ---------------------------------------------------------------------------

describe('isCommentCommand', () => {
  it('matches gh pr comment', () => {
    expect(isCommentCommand('gh pr comment 42 --body "hello"')).toBe(true);
  });

  it('matches gh issue comment', () => {
    expect(isCommentCommand('gh issue comment 7 --body "done"')).toBe(true);
  });

  it('matches gh pr review', () => {
    expect(isCommentCommand('gh pr review 42 --approve')).toBe(true);
  });

  it('matches gh api with comments endpoint', () => {
    expect(isCommentCommand('gh api repos/a/b/issues/1/comments --method POST')).toBe(true);
  });

  it('matches gh api with reviews endpoint', () => {
    expect(isCommentCommand('gh api repos/a/b/pulls/1/reviews --method POST')).toBe(true);
  });

  it('rejects gh pr merge (not a comment)', () => {
    expect(isCommentCommand('gh pr merge 42')).toBe(false);
  });

  it('rejects gh pr view', () => {
    expect(isCommentCommand('gh pr view 42')).toBe(false);
  });

  it('rejects cargo build', () => {
    expect(isCommentCommand('cargo build')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isCommentCommand('')).toBe(false);
  });

  // Property: commands without gh pr/issue comment/review never match
  it('non-gh commands never match (property)', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) =>
          !/\bgh\s+(?:pr|issue)\s+(?:comment|review)\b/.test(s) &&
          !(/\bgh\s+api\b/.test(s) && /\b(?:comments|reviews)\b/.test(s))
        ),
        (command) => {
          expect(isCommentCommand(command)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// extractCommentIds
// ---------------------------------------------------------------------------

describe('extractCommentIds', () => {
  it('extracts comment ID from URL in output', () => {
    const output = 'https://github.com/owner/repo/pull/42#issuecomment-12345';
    const results = extractCommentIds(output);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ commentId: 12345, repo: 'owner/repo', prNumber: 42 });
  });

  it('extracts multiple comment IDs from output with multiple URLs', () => {
    const output = [
      'https://github.com/a/b/pull/1#issuecomment-111',
      'https://github.com/a/b/pull/1#issuecomment-222',
    ].join('\n');
    const results = extractCommentIds(output);
    expect(results).toHaveLength(2);
    expect(results[0]!.commentId).toBe(111);
    expect(results[1]!.commentId).toBe(222);
  });

  it('falls back to JSON parsing when no URL found', () => {
    const output = JSON.stringify({ id: 99999, body: 'test', node_id: 'abc' });
    const results = extractCommentIds(output);
    expect(results).toHaveLength(1);
    expect(results[0]!.commentId).toBe(99999);
  });

  it('returns empty array for output with no comment IDs', () => {
    expect(extractCommentIds('Build succeeded.')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractCommentIds('')).toEqual([]);
  });

  it('prefers URL parsing over JSON parsing', () => {
    const output = '{"id": 999}\nhttps://github.com/a/b/pull/1#issuecomment-111';
    const results = extractCommentIds(output);
    // URL match found, so JSON fallback is skipped
    expect(results).toHaveLength(1);
    expect(results[0]!.commentId).toBe(111);
  });
});
