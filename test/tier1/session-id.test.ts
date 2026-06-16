import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { resolveSessionId } from '../../src/session-id.js';

describe('resolveSessionId', () => {
  describe('unique match', () => {
    it('resolves a full ID against itself', () => {
      const id = 'abcd1234-5678-9abc-def0-111111111111';
      const result = resolveSessionId(id, [id]);
      expect(result).toEqual({ kind: 'match', sessionId: id });
    });

    it('resolves a short prefix when unambiguous', () => {
      const candidates = [
        'abcd1234-5678-9abc-def0-111111111111',
        'efgh5678-1234-5678-9abc-222222222222',
      ];
      const result = resolveSessionId('abcd', candidates);
      expect(result).toEqual({ kind: 'match', sessionId: candidates[0] });
    });

    it('resolves single-character prefix when only one candidate matches', () => {
      const candidates = ['a1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222'];
      const result = resolveSessionId('a', candidates);
      expect(result).toEqual({ kind: 'match', sessionId: candidates[0] });
    });
  });

  describe('no match', () => {
    it('returns no_match for empty candidates', () => {
      const result = resolveSessionId('abc', []);
      expect(result).toEqual({ kind: 'no_match' });
    });

    it('returns no_match when prefix does not match any candidate', () => {
      const candidates = ['aaaa1111-1111-1111-1111-111111111111', 'bbbb2222-2222-2222-2222-222222222222'];
      const result = resolveSessionId('cccc', candidates);
      expect(result).toEqual({ kind: 'no_match' });
    });
  });

  describe('ambiguous match', () => {
    it('returns ambiguous when multiple candidates share the prefix', () => {
      const candidates = [
        'abcd1111-1111-1111-1111-111111111111',
        'abcd2222-2222-2222-2222-222222222222',
        'efgh3333-3333-3333-3333-333333333333',
      ];
      const result = resolveSessionId('abcd', candidates);
      expect(result).toEqual({
        kind: 'ambiguous',
        candidates: [candidates[0], candidates[1]],
      });
    });

    it('returns all matching candidates in original order', () => {
      const candidates = [
        'aa111111-1111-1111-1111-111111111111',
        'aa222222-2222-2222-2222-222222222222',
        'aa333333-3333-3333-3333-333333333333',
      ];
      const result = resolveSessionId('aa', candidates);
      expect(result.kind).toBe('ambiguous');
      if (result.kind === 'ambiguous') {
        expect(result.candidates).toEqual(candidates);
      }
    });
  });

  describe('edge cases', () => {
    it('empty prefix matches all candidates (ambiguous if >1)', () => {
      const candidates = ['a1111111', 'b2222222'];
      const result = resolveSessionId('', candidates);
      expect(result.kind).toBe('ambiguous');
    });

    it('empty prefix with single candidate is a match', () => {
      const id = 'abcd1234';
      const result = resolveSessionId('', [id]);
      expect(result).toEqual({ kind: 'match', sessionId: id });
    });

    it('empty prefix with empty candidates is no_match', () => {
      const result = resolveSessionId('', []);
      expect(result).toEqual({ kind: 'no_match' });
    });
  });

  describe('property tests', () => {
    const uuidArb = fc.uuid();

    it('a full ID always resolves to itself when present', () => {
      fc.assert(
        fc.property(
          fc.array(uuidArb, { minLength: 1, maxLength: 50 }),
          fc.nat(),
          (candidates, indexRaw) => {
            const unique = [...new Set(candidates)];
            if (unique.length === 0) return;
            const idx = indexRaw % unique.length;
            const target = unique[idx]!;
            const result = resolveSessionId(target, unique);
            expect(result).toEqual({ kind: 'match', sessionId: target });
          },
        ),
        { numRuns: 200 },
      );
    });

    it('result kind is always one of match, no_match, ambiguous', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 8 }),
          fc.array(uuidArb, { minLength: 0, maxLength: 20 }),
          (prefix, candidates) => {
            const result = resolveSessionId(prefix, candidates);
            expect(['match', 'no_match', 'ambiguous']).toContain(result.kind);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('match result sessionId always starts with the given prefix', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 4 }),
          fc.array(uuidArb, { minLength: 1, maxLength: 20 }),
          (prefix, candidates) => {
            const result = resolveSessionId(prefix, candidates);
            if (result.kind === 'match') {
              expect(result.sessionId.startsWith(prefix)).toBe(true);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('ambiguous candidates all start with the given prefix', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 4 }),
          fc.array(uuidArb, { minLength: 2, maxLength: 20 }),
          (prefix, candidates) => {
            const result = resolveSessionId(prefix, candidates);
            if (result.kind === 'ambiguous') {
              for (const c of result.candidates) {
                expect(c.startsWith(prefix)).toBe(true);
              }
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it('no_match means no candidate starts with prefix', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 8 }),
          fc.array(uuidArb, { minLength: 0, maxLength: 20 }),
          (prefix, candidates) => {
            const result = resolveSessionId(prefix, candidates);
            if (result.kind === 'no_match') {
              expect(candidates.every((c) => !c.startsWith(prefix))).toBe(true);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
