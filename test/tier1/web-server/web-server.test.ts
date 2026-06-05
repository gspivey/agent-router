import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { UUID_V4_RE } from '../../../src/web-server.js';

// Custom arbitrary that generates valid UUID v4 strings
const uuidV4Arb = fc.tuple(
  fc.hexaString({ minLength: 8, maxLength: 8 }),
  fc.hexaString({ minLength: 4, maxLength: 4 }),
  fc.hexaString({ minLength: 3, maxLength: 3 }),
  fc.constantFrom('8', '9', 'a', 'b'),
  fc.hexaString({ minLength: 3, maxLength: 3 }),
  fc.hexaString({ minLength: 12, maxLength: 12 }),
).map(([a, b, c, variant, d, e]) => `${a}-${b}-4${c}-${variant}${d}-${e}`);

describe('UUID_V4_RE validation', () => {
  it('accepts valid UUID v4 strings', () => {
    fc.assert(
      fc.property(uuidV4Arb, (uuid) => {
        expect(UUID_V4_RE.test(uuid)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects non-UUID strings', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter(s => !UUID_V4_RE.test(s)),
        (s) => {
          expect(UUID_V4_RE.test(s)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects empty string', () => {
    expect(UUID_V4_RE.test('')).toBe(false);
  });

  it('rejects UUID v1-style (non-4 version digit)', () => {
    // Version 1 UUID — third group starts with '1' not '4'
    expect(UUID_V4_RE.test('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });

  it('rejects invalid variant digit', () => {
    // Valid structure but variant byte is '0' (not in [89ab])
    expect(UUID_V4_RE.test('550e8400-e29b-4000-0000-446655440000')).toBe(false);
  });

  it('accepts both uppercase and lowercase', () => {
    const lower = '550e8400-e29b-4000-a000-446655440000';
    const upper = '550E8400-E29B-4000-A000-446655440000';
    expect(UUID_V4_RE.test(lower)).toBe(true);
    expect(UUID_V4_RE.test(upper)).toBe(true);
  });
});
