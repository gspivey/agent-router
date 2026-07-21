/**
 * Tier 1 tests for src/secret.ts
 *
 * Covers:
 *  - Property 8: Token redaction in logs (arbitrary non-empty strings wrapped in Secret
 *    must never expose the raw value via toString, toJSON, or JSON.stringify)
 *  - Edge case unit tests: empty string rejects, reveal returns raw value,
 *    console.log / util.inspect output is redacted
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as util from 'node:util';
import { Secret } from '../../src/secret.js';

describe('Secret', () => {
  // ---------------------------------------------------------------------------
  // Property 8: Token redaction in logs
  // ---------------------------------------------------------------------------
  describe('Property 8: Token redaction', () => {
    it('toString() always returns [REDACTED] regardless of input', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          (raw) => {
            const s = Secret.of(raw);
            expect(s.toString()).toBe('[REDACTED]');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('toJSON() always returns [REDACTED] regardless of input', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          (raw) => {
            const s = Secret.of(raw);
            expect(s.toJSON()).toBe('[REDACTED]');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('JSON.stringify() serializes to [REDACTED], never the raw value', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          (raw) => {
            const s = Secret.of(raw);
            const jsonOutput = JSON.stringify({ token: s });
            // Parse back and verify the serialized value is [REDACTED], never the raw
            const parsed = JSON.parse(jsonOutput) as { token: string };
            expect(parsed.token).toBe('[REDACTED]');
            // Additionally verify the raw value is never present as a JSON string value
            // (the toJSON method should have been called)
            expect(jsonOutput).toBe('{"token":"[REDACTED]"}');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('util.inspect() always returns [REDACTED] regardless of input', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          (raw) => {
            const s = Secret.of(raw);
            const inspected = util.inspect(s);
            expect(inspected).toBe('[REDACTED]');
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Edge case unit tests
  // ---------------------------------------------------------------------------
  describe('Secret.of() edge cases', () => {
    it('throws when given an empty string', () => {
      expect(() => Secret.of('')).toThrow('Secret cannot be empty');
    });

    it('does not throw for a non-empty string', () => {
      expect(() => Secret.of('abc')).not.toThrow();
    });
  });

  describe('reveal()', () => {
    it('returns the original raw value', () => {
      const raw = 'ghp_supersecret123';
      const s = Secret.of(raw);
      expect(s.reveal()).toBe(raw);
    });

    it('round-trips arbitrary non-empty strings', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          (raw) => {
            const s = Secret.of(raw);
            expect(s.reveal()).toBe(raw);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('console.log / util.inspect redaction', () => {
    it('util.inspect output contains [REDACTED] not the raw value', () => {
      const raw = 'mysecrettoken';
      const s = Secret.of(raw);
      const inspected = util.inspect(s);
      expect(inspected).toContain('[REDACTED]');
      expect(inspected).not.toContain(raw);
    });

    it('[Symbol.for nodejs.util.inspect.custom] returns [REDACTED]', () => {
      const raw = 'anothersecret';
      const s = Secret.of(raw);
      // Access the custom inspect symbol directly
      const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');
      const customInspect = (s as unknown as Record<symbol, () => string>)[inspectSymbol];
      expect(customInspect).toBeDefined();
      expect(customInspect!()).toBe('[REDACTED]');
    });

    it('template literal interpolation returns [REDACTED]', () => {
      const raw = 'token_value';
      const s = Secret.of(raw);
      const interpolated = `${s}`;
      expect(interpolated).toBe('[REDACTED]');
      expect(interpolated).not.toContain(raw);
    });

    it('String() coercion returns [REDACTED]', () => {
      const raw = 'some_secret';
      const s = Secret.of(raw);
      expect(String(s)).toBe('[REDACTED]');
    });
  });

  describe('JSON serialization edge cases', () => {
    it('JSON.stringify inside an object produces "[REDACTED]" for the token field', () => {
      const s = Secret.of('bearer_token');
      const obj = { auth: s, count: 1 };
      const json = JSON.stringify(obj);
      expect(JSON.parse(json)).toEqual({ auth: '[REDACTED]', count: 1 });
    });

    it('JSON.stringify inside an array produces "[REDACTED]" for the token entry', () => {
      const s = Secret.of('array_token');
      const arr = [s, 'other'];
      const json = JSON.stringify(arr);
      expect(JSON.parse(json)).toEqual(['[REDACTED]', 'other']);
    });
  });
});
