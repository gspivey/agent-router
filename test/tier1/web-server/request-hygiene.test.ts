import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validatePrompt } from '../../../src/web-routes.js';

describe('Property 15: Invalid Prompt Rejection', () => {
  it('rejects whitespace-only strings', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 0, maxLength: 50 }),
        (ws) => {
          const result = validatePrompt({ prompt: ws });
          expect(result.valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects strings exceeding 10000 chars after trimming', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 10001, maxLength: 15000 }),
        (s) => {
          // Ensure the trimmed string is still over the limit
          const trimmed = s.trim();
          if (trimmed.length > 10000) {
            const result = validatePrompt({ prompt: s });
            expect(result.valid).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('accepts valid prompts (1-10000 chars after trim, non-whitespace)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10000 }).filter(s => s.trim().length > 0 && s.trim().length <= 10000),
        (s) => {
          const result = validatePrompt({ prompt: s });
          expect(result.valid).toBe(true);
          if (result.valid) {
            expect(result.prompt).toBe(s.trim());
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects missing prompt field', () => {
    expect(validatePrompt({})).toEqual({ valid: false, reason: 'Missing or invalid "prompt" field' });
    expect(validatePrompt({ prompt: 123 })).toEqual({ valid: false, reason: 'Missing or invalid "prompt" field' });
    expect(validatePrompt(null)).toEqual({ valid: false, reason: 'Request body must be a JSON object' });
  });
});
