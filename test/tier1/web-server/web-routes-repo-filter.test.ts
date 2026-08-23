/**
 * Tier 1 test: validateRepo helper for the repo query parameter on GET /sessions.
 * Validates ROADMAP item #55, task 7.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateRepo } from '../../../src/web-routes.js';

describe('validateRepo', () => {
  it('accepts owner/name format', () => {
    expect(validateRepo('org/repo')).toBe(true);
    expect(validateRepo('gspivey/agent-router')).toBe(true);
    expect(validateRepo('a/b')).toBe(true);
  });

  it('rejects strings without a slash', () => {
    expect(validateRepo('no-slash')).toBe(false);
    expect(validateRepo('')).toBe(false);
    expect(validateRepo('justaname')).toBe(false);
  });

  it('accepts any string containing a slash (property)', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes('/')),
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes('/')),
        ),
        ([owner, name]) => {
          expect(validateRepo(`${owner}/${name}`)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects strings without slash (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 40 }).filter(s => !s.includes('/')),
        (s) => {
          expect(validateRepo(s)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
