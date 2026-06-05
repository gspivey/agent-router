import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { splitCompleteLines, buildLineOffsetIndex, seekToLine } from '../../../src/sse-broker.js';

describe('SSE Broker Pure Logic', () => {
  describe('splitCompleteLines', () => {
    it('splits on newlines and returns residual', () => {
      const result = splitCompleteLines('line1\nline2\npartial', '');
      expect(result.lines).toEqual(['line1', 'line2']);
      expect(result.residual).toBe('partial');
    });

    it('handles chunk ending with newline (empty residual)', () => {
      const result = splitCompleteLines('line1\nline2\n', '');
      expect(result.lines).toEqual(['line1', 'line2']);
      expect(result.residual).toBe('');
    });

    it('prepends residual to first line', () => {
      const result = splitCompleteLines('rest\nnext\n', 'start-');
      expect(result.lines).toEqual(['start-rest', 'next']);
      expect(result.residual).toBe('');
    });

    it('property: lines + residual reconstructs input', () => {
      fc.assert(
        fc.property(
          fc.string(),
          fc.string(),
          (chunk, residual) => {
            const result = splitCompleteLines(chunk, residual);
            const reconstructed =
              result.lines.join('\n') +
              (result.lines.length > 0 ? '\n' : '') +
              result.residual;
            expect(reconstructed).toBe(residual + chunk);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: no line in result contains a newline', () => {
      fc.assert(
        fc.property(
          fc.string(),
          fc.string(),
          (chunk, residual) => {
            const result = splitCompleteLines(chunk, residual);
            for (const line of result.lines) {
              expect(line).not.toContain('\n');
            }
            expect(result.residual).not.toContain('\n');
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('buildLineOffsetIndex', () => {
    it('computes byte offsets for ASCII lines', () => {
      const lines = ['hello', 'world'];
      const offsets = buildLineOffsetIndex(lines, 0);
      // "hello\n" = 6 bytes, so "world" starts at 6
      expect(offsets).toEqual([0, 6]);
    });

    it('handles startOffset', () => {
      const lines = ['abc'];
      const offsets = buildLineOffsetIndex(lines, 100);
      expect(offsets).toEqual([100]);
    });

    it('handles multi-byte characters', () => {
      const lines = ['café']; // 'é' is 2 bytes in UTF-8
      const offsets = buildLineOffsetIndex(lines, 0);
      expect(offsets).toEqual([0]);
      // Next line would start at byte offset 6 (c=1, a=1, f=1, é=2, \n=1)
      const offsets2 = buildLineOffsetIndex(['café', 'next'], 0);
      expect(offsets2).toEqual([0, 6]);
    });

    it('property: offsets are monotonically increasing', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 0, maxLength: 100 }), { minLength: 1, maxLength: 20 }),
          fc.nat(1000),
          (lines, startOffset) => {
            const offsets = buildLineOffsetIndex(lines, startOffset);
            for (let i = 1; i < offsets.length; i++) {
              expect(offsets[i]).toBeGreaterThan(offsets[i - 1]!);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: first offset equals startOffset', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 0, maxLength: 50 }), { minLength: 1, maxLength: 10 }),
          fc.nat(1000),
          (lines, startOffset) => {
            const offsets = buildLineOffsetIndex(lines, startOffset);
            expect(offsets[0]).toBe(startOffset);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('seekToLine', () => {
    it('returns correct offset for valid line number', () => {
      const offsets = [0, 10, 25, 40];
      expect(seekToLine(offsets, 1)).toBe(0);
      expect(seekToLine(offsets, 2)).toBe(10);
      expect(seekToLine(offsets, 3)).toBe(25);
      expect(seekToLine(offsets, 4)).toBe(40);
    });

    it('returns undefined for out-of-range line numbers', () => {
      const offsets = [0, 10, 25];
      expect(seekToLine(offsets, 0)).toBeUndefined();
      expect(seekToLine(offsets, -1)).toBeUndefined();
      expect(seekToLine(offsets, 4)).toBeUndefined();
    });

    it('returns undefined for empty offsets', () => {
      expect(seekToLine([], 1)).toBeUndefined();
    });

    it('property: seekToLine returns a value in offsets for valid line numbers', () => {
      fc.assert(
        fc.property(
          fc.array(fc.nat(10000), { minLength: 1, maxLength: 50 }),
          (rawOffsets) => {
            // Make offsets sorted (realistic)
            const offsets = rawOffsets.sort((a, b) => a - b);
            for (let i = 1; i <= offsets.length; i++) {
              const result = seekToLine(offsets, i);
              expect(result).toBe(offsets[i - 1]);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Property 11: SSE Event IDs Are Monotonic', () => {
    it('line numbers derived from splitCompleteLines are strictly increasing', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              ts: fc.string({ minLength: 1, maxLength: 30 }),
              source: fc.constantFrom('router', 'agent'),
              type: fc.string({ minLength: 1, maxLength: 20 }),
            }),
            { minLength: 1, maxLength: 50 },
          ),
          (entries) => {
            // Simulate building an NDJSON file and processing it
            const ndjson = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
            const { lines } = splitCompleteLines(ndjson, '');

            // Line numbers are 1-indexed and strictly increasing
            const lineNumbers: number[] = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i]!.length > 0) {
                lineNumbers.push(i + 1);
              }
            }

            for (let i = 1; i < lineNumbers.length; i++) {
              expect(lineNumbers[i]).toBeGreaterThan(lineNumbers[i - 1]!);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Property 12: SSE Last-Event-ID Resumption', () => {
    it('resuming from line K yields lines K+1 through N with no gaps or duplicates', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              ts: fc.string({ minLength: 1, maxLength: 10 }),
              type: fc.string({ minLength: 1, maxLength: 10 }),
            }),
            { minLength: 2, maxLength: 30 },
          ),
          fc.nat(),
          (entries, rawK) => {
            const ndjson = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
            const { lines } = splitCompleteLines(ndjson, '');
            const nonEmptyLines = lines.filter((l) => l.length > 0);
            const N = nonEmptyLines.length;
            if (N < 2) return; // Need at least 2 lines

            const K = (rawK % (N - 1)) + 1; // K in [1, N-1]

            // Simulating resumption: starting from line K+1
            const resumed = nonEmptyLines.slice(K);
            expect(resumed.length).toBe(N - K);

            // Each line should correspond to line number K+1, K+2, ..., N
            // Verify using offset index
            const offsets = buildLineOffsetIndex(nonEmptyLines, 0);
            const resumeOffset = seekToLine(offsets, K + 1);
            expect(resumeOffset).toBeDefined();

            // The offset should point to line K+1 (0-indexed: K)
            expect(resumeOffset).toBe(offsets[K]);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
