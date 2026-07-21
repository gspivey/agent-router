/**
 * Tier 1 tests for credential validators (src/credential-validators.ts).
 *
 * Covers:
 * - Property 6: Write authorization enforcement
 * - Property 11: HTTP method validation
 * - Property 12: GitHub API path validation
 * - Property 13: Request body size enforcement
 * - Unit tests for validation edge cases
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validateMethod,
  validatePathPrefix,
  validateBodySize,
  validateRepoAuthorization,
  VALID_METHODS,
  GITHUB_API_PREFIXES,
  MAX_BODY_SIZE_BYTES,
  WRITE_METHODS,
} from '../../src/credential-validators.js';

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('credential-validators property tests', () => {
  // Feature: auth-credential-proxy, Property 11: HTTP method validation
  describe('Property 11: HTTP method validation', () => {
    it('accepts iff method is one of the five valid methods', () => {
      const validSet = new Set(VALID_METHODS as readonly string[]);

      fc.assert(
        fc.property(fc.string(), (method) => {
          const result = validateMethod(method);
          if (validSet.has(method)) {
            expect(result).toBeNull();
          } else {
            expect(result).not.toBeNull();
            expect(result!.code).toBe('method_invalid');
          }
        }),
        { numRuns: 200 },
      );
    });

    it('always accepts the five valid methods', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...VALID_METHODS),
          (method) => {
            expect(validateMethod(method)).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('rejects arbitrary non-method strings', () => {
      fc.assert(
        fc.property(
          fc.string().filter((s) => !(VALID_METHODS as readonly string[]).includes(s)),
          (method) => {
            const result = validateMethod(method);
            expect(result).not.toBeNull();
            expect(result!.code).toBe('method_invalid');
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: auth-credential-proxy, Property 12: GitHub API path validation
  describe('Property 12: GitHub API path validation', () => {
    const arbValidPath = fc.constantFrom(...GITHUB_API_PREFIXES).chain((prefix) =>
      fc.string().map((suffix) => prefix + suffix),
    );

    it('accepts iff path starts with a known GitHub API prefix', () => {
      fc.assert(
        fc.property(fc.string(), (path) => {
          const hasValidPrefix = GITHUB_API_PREFIXES.some((p) => path.startsWith(p));
          const result = validatePathPrefix(path);
          if (hasValidPrefix) {
            expect(result).toBeNull();
          } else {
            expect(result).not.toBeNull();
            expect(result!.code).toBe('path_invalid');
          }
        }),
        { numRuns: 200 },
      );
    });

    it('always accepts paths starting with a valid prefix', () => {
      fc.assert(
        fc.property(arbValidPath, (path) => {
          expect(validatePathPrefix(path)).toBeNull();
        }),
        { numRuns: 100 },
      );
    });

    it('rejects paths not starting with any valid prefix', () => {
      fc.assert(
        fc.property(
          fc.string().filter((s) => !GITHUB_API_PREFIXES.some((p) => s.startsWith(p))),
          (path) => {
            const result = validatePathPrefix(path);
            expect(result).not.toBeNull();
            expect(result!.code).toBe('path_invalid');
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: auth-credential-proxy, Property 13: Request body size enforcement
  describe('Property 13: Request body size enforcement', () => {
    it('rejects iff Buffer.byteLength(body) > 10 MB', () => {
      // Test with small strings (always accepted)
      fc.assert(
        fc.property(
          fc.string({ maxLength: 1000 }),
          (body) => {
            const result = validateBodySize(body);
            if (Buffer.byteLength(body) > MAX_BODY_SIZE_BYTES) {
              expect(result).not.toBeNull();
              expect(result!.code).toBe('body_too_large');
            } else {
              expect(result).toBeNull();
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('always accepts undefined body', () => {
      expect(validateBodySize(undefined)).toBeNull();
    });

    it('accepts body of exactly MAX_BODY_SIZE_BYTES', () => {
      // Create a string of exactly 10 MB using ASCII chars (1 byte each)
      const body = 'a'.repeat(MAX_BODY_SIZE_BYTES);
      expect(Buffer.byteLength(body)).toBe(MAX_BODY_SIZE_BYTES);
      expect(validateBodySize(body)).toBeNull();
    });

    it('rejects body of MAX_BODY_SIZE_BYTES + 1', () => {
      const body = 'a'.repeat(MAX_BODY_SIZE_BYTES + 1);
      expect(Buffer.byteLength(body)).toBe(MAX_BODY_SIZE_BYTES + 1);
      const result = validateBodySize(body);
      expect(result).not.toBeNull();
      expect(result!.code).toBe('body_too_large');
    });
  });

  // Feature: auth-credential-proxy, Property 6: Write authorization enforcement
  describe('Property 6: Write authorization enforcement', () => {
    const arbRepoName = fc.tuple(
      fc.stringMatching(/^[a-zA-Z0-9._-]+$/).filter((s) => s.length > 0),
      fc.stringMatching(/^[a-zA-Z0-9._-]+$/).filter((s) => s.length > 0),
    ).map(([owner, name]) => `${owner}/${name}`);

    const arbWriteMethod = fc.constantFrom(...WRITE_METHODS);
    const arbReadMethod = fc.constant('GET');

    it('write methods: permitted iff repo is in Bound_Project repos', () => {
      fc.assert(
        fc.property(
          arbWriteMethod,
          fc.array(arbRepoName, { minLength: 1, maxLength: 5 }),
          fc.array(arbRepoName, { minLength: 0, maxLength: 3 }),
          arbRepoName,
          (method, boundRepos, readRepos, targetRepo) => {
            const ctx = { boundProjectRepos: boundRepos, readRepos };
            const result = validateRepoAuthorization(method, targetRepo, ctx);

            if (boundRepos.includes(targetRepo)) {
              expect(result).toBeNull();
            } else {
              expect(result).not.toBeNull();
              expect(result!.code).toBe('repo_unauthorized');
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('read methods (GET): permitted iff repo is in boundProjectRepos OR readRepos', () => {
      fc.assert(
        fc.property(
          arbReadMethod,
          fc.array(arbRepoName, { minLength: 1, maxLength: 5 }),
          fc.array(arbRepoName, { minLength: 0, maxLength: 3 }),
          arbRepoName,
          (method, boundRepos, readRepos, targetRepo) => {
            const ctx = { boundProjectRepos: boundRepos, readRepos };
            const result = validateRepoAuthorization(method, targetRepo, ctx);

            if (boundRepos.includes(targetRepo) || readRepos.includes(targetRepo)) {
              expect(result).toBeNull();
            } else {
              expect(result).not.toBeNull();
              expect(result!.code).toBe('repo_unauthorized');
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('write methods: never authorized by readRepos alone', () => {
      fc.assert(
        fc.property(
          arbWriteMethod,
          arbRepoName,
          (method, repo) => {
            // Repo is ONLY in readRepos, not in boundProjectRepos
            const ctx = { boundProjectRepos: [], readRepos: [repo] };
            const result = validateRepoAuthorization(method, repo, ctx);
            expect(result).not.toBeNull();
            expect(result!.code).toBe('repo_unauthorized');
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Unit Tests for Edge Cases (Task 15.4)
// ---------------------------------------------------------------------------

describe('credential-validators unit tests', () => {
  describe('validateMethod', () => {
    it('accepts all five valid methods', () => {
      for (const m of VALID_METHODS) {
        expect(validateMethod(m)).toBeNull();
      }
    });

    it('rejects lowercase methods', () => {
      expect(validateMethod('get')).not.toBeNull();
      expect(validateMethod('post')).not.toBeNull();
      expect(validateMethod('put')).not.toBeNull();
      expect(validateMethod('patch')).not.toBeNull();
      expect(validateMethod('delete')).not.toBeNull();
    });

    it('rejects mixed-case methods', () => {
      expect(validateMethod('Get')).not.toBeNull();
      expect(validateMethod('Post')).not.toBeNull();
    });

    it('rejects empty string', () => {
      expect(validateMethod('')).not.toBeNull();
    });

    it('rejects CONNECT, OPTIONS, HEAD, TRACE', () => {
      expect(validateMethod('CONNECT')).not.toBeNull();
      expect(validateMethod('OPTIONS')).not.toBeNull();
      expect(validateMethod('HEAD')).not.toBeNull();
      expect(validateMethod('TRACE')).not.toBeNull();
    });

    it('error has code and message', () => {
      const result = validateMethod('INVALID');
      expect(result).toEqual({
        code: 'method_invalid',
        message: expect.stringContaining('INVALID'),
      });
    });
  });

  describe('validatePathPrefix', () => {
    it('accepts all valid prefix paths', () => {
      expect(validatePathPrefix('/repos/owner/name/pulls')).toBeNull();
      expect(validatePathPrefix('/orgs/myorg/repos')).toBeNull();
      expect(validatePathPrefix('/users/octocat')).toBeNull();
      expect(validatePathPrefix('/gists/abc123')).toBeNull();
      expect(validatePathPrefix('/search/repositories?q=test')).toBeNull();
      expect(validatePathPrefix('/notifications/threads/1')).toBeNull();
      expect(validatePathPrefix('/issues/123')).toBeNull();
      expect(validatePathPrefix('/pulls/456')).toBeNull();
    });

    it('accepts paths that are just the prefix', () => {
      for (const prefix of GITHUB_API_PREFIXES) {
        expect(validatePathPrefix(prefix)).toBeNull();
      }
    });

    it('rejects paths without a valid prefix', () => {
      expect(validatePathPrefix('/api/repos')).not.toBeNull();
      expect(validatePathPrefix('/v3/repos')).not.toBeNull();
      expect(validatePathPrefix('repos/')).not.toBeNull();
      expect(validatePathPrefix('/REPOS/')).not.toBeNull();
      expect(validatePathPrefix('')).not.toBeNull();
      expect(validatePathPrefix('/')).not.toBeNull();
      expect(validatePathPrefix('/admin/hooks')).not.toBeNull();
    });

    it('is case-sensitive', () => {
      expect(validatePathPrefix('/Repos/owner/name')).not.toBeNull();
      expect(validatePathPrefix('/REPOS/owner/name')).not.toBeNull();
    });

    it('error has code and message', () => {
      const result = validatePathPrefix('/invalid/path');
      expect(result).toEqual({
        code: 'path_invalid',
        message: expect.stringContaining('must start with'),
      });
    });
  });

  describe('validateBodySize', () => {
    it('accepts undefined', () => {
      expect(validateBodySize(undefined)).toBeNull();
    });

    it('accepts empty string', () => {
      expect(validateBodySize('')).toBeNull();
    });

    it('accepts small body', () => {
      expect(validateBodySize('{"key":"value"}')).toBeNull();
    });

    it('accepts body at exactly 10 MB', () => {
      const body = 'x'.repeat(MAX_BODY_SIZE_BYTES);
      expect(validateBodySize(body)).toBeNull();
    });

    it('rejects body at 10 MB + 1 byte', () => {
      const body = 'x'.repeat(MAX_BODY_SIZE_BYTES + 1);
      const result = validateBodySize(body);
      expect(result).not.toBeNull();
      expect(result!.code).toBe('body_too_large');
    });

    it('counts multi-byte characters correctly', () => {
      // A single emoji (4 bytes in UTF-8)
      const emoji = '😀';
      expect(Buffer.byteLength(emoji)).toBe(4);

      // 10 MB = 10 * 1024 * 1024 = 10485760 bytes
      // 10485760 / 4 = 2621440 emojis for exactly 10 MB
      const exactCount = MAX_BODY_SIZE_BYTES / 4;
      const body = emoji.repeat(exactCount);
      expect(Buffer.byteLength(body)).toBe(MAX_BODY_SIZE_BYTES);
      expect(validateBodySize(body)).toBeNull();

      // One more emoji puts it over
      const overBody = body + emoji;
      expect(Buffer.byteLength(overBody)).toBe(MAX_BODY_SIZE_BYTES + 4);
      expect(validateBodySize(overBody)).not.toBeNull();
    });

    it('error has code and message', () => {
      const body = 'x'.repeat(MAX_BODY_SIZE_BYTES + 1);
      const result = validateBodySize(body);
      expect(result).toEqual({
        code: 'body_too_large',
        message: expect.stringContaining('10 MB'),
      });
    });
  });

  describe('validateRepoAuthorization', () => {
    const ctx = {
      boundProjectRepos: ['org/repo-a', 'org/repo-b'],
      readRepos: ['other/read-only'],
    };

    describe('write methods', () => {
      for (const method of WRITE_METHODS) {
        it(`${method}: allows repo in bound project`, () => {
          expect(validateRepoAuthorization(method, 'org/repo-a', ctx)).toBeNull();
          expect(validateRepoAuthorization(method, 'org/repo-b', ctx)).toBeNull();
        });

        it(`${method}: rejects repo not in bound project`, () => {
          const result = validateRepoAuthorization(method, 'org/unknown', ctx);
          expect(result).not.toBeNull();
          expect(result!.code).toBe('repo_unauthorized');
        });

        it(`${method}: rejects repo only in read_repos`, () => {
          const result = validateRepoAuthorization(method, 'other/read-only', ctx);
          expect(result).not.toBeNull();
          expect(result!.code).toBe('repo_unauthorized');
        });
      }
    });

    describe('GET (read method)', () => {
      it('allows repo in bound project', () => {
        expect(validateRepoAuthorization('GET', 'org/repo-a', ctx)).toBeNull();
      });

      it('allows repo in read_repos', () => {
        expect(validateRepoAuthorization('GET', 'other/read-only', ctx)).toBeNull();
      });

      it('rejects repo not in either list', () => {
        const result = validateRepoAuthorization('GET', 'unknown/repo', ctx);
        expect(result).not.toBeNull();
        expect(result!.code).toBe('repo_unauthorized');
      });
    });

    describe('edge cases', () => {
      it('empty boundProjectRepos rejects all writes', () => {
        const emptyCtx = { boundProjectRepos: [], readRepos: [] };
        expect(validateRepoAuthorization('POST', 'org/repo', emptyCtx)).not.toBeNull();
      });

      it('empty readRepos with repo in boundProjectRepos allows GET', () => {
        const ctx2 = { boundProjectRepos: ['org/repo'], readRepos: [] };
        expect(validateRepoAuthorization('GET', 'org/repo', ctx2)).toBeNull();
      });

      it('repo matching is exact (no prefix matching)', () => {
        const ctx2 = { boundProjectRepos: ['org/repo'], readRepos: [] };
        expect(validateRepoAuthorization('POST', 'org/repo-extra', ctx2)).not.toBeNull();
        expect(validateRepoAuthorization('POST', 'org/rep', ctx2)).not.toBeNull();
      });
    });
  });
});
