import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateLines, tailStreamLog } from '../../../src/web-routes.js';

describe('Property 9: Detail Entries Are Chronological', () => {
  it('entries are returned in file order (earliest first)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ts: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }).map(d => d.toISOString()),
            source: fc.constantFrom('router', 'agent'),
            type: fc.string({ minLength: 1, maxLength: 20 }),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        (entries) => {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-test-'));
          const streamPath = path.join(tmpDir, 'stream.log');
          const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
          fs.writeFileSync(streamPath, content);

          const result = tailStreamLog(streamPath, 2000);
          // Entries should be in the same order as written
          expect(result.entries.length).toBe(entries.length);
          for (let i = 0; i < entries.length; i++) {
            const entry = result.entries[i] as Record<string, unknown>;
            expect(entry['ts']).toBe(entries[i]!.ts);
          }

          fs.rmSync(tmpDir, { recursive: true });
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 10: Detail Tail Correctness', () => {
  it('returns exactly min(lines, N) entries from the end', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ts: fc.constant(new Date().toISOString()),
            source: fc.constant('router'),
            type: fc.string({ minLength: 1, maxLength: 10 }),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        fc.integer({ min: 1, max: 2000 }),
        (entries, lines) => {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-test-'));
          const streamPath = path.join(tmpDir, 'stream.log');
          const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
          fs.writeFileSync(streamPath, content);

          const result = tailStreamLog(streamPath, lines);
          const expectedCount = Math.min(lines, entries.length);
          expect(result.entries.length).toBe(expectedCount);

          fs.rmSync(tmpDir, { recursive: true });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('skips malformed JSON lines and reports skipped count', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-test-'));
    const streamPath = path.join(tmpDir, 'stream.log');
    const lines = [
      JSON.stringify({ ts: '2025-01-01T00:00:00Z', source: 'router', type: 'a' }),
      'not json at all',
      JSON.stringify({ ts: '2025-01-01T00:01:00Z', source: 'router', type: 'b' }),
      '{broken',
    ];
    fs.writeFileSync(streamPath, lines.join('\n') + '\n');

    const result = tailStreamLog(streamPath, 2000);
    expect(result.entries.length).toBe(2);
    expect(result.skipped_lines).toBe(2);

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('validateLines', () => {
  it('accepts integers between 1 and 2000', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2000 }), (n) => {
        expect(validateLines(String(n))).toBe(n);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects out-of-range values', () => {
    expect(validateLines('0')).toBeNull();
    expect(validateLines('2001')).toBeNull();
    expect(validateLines('-1')).toBeNull();
    expect(validateLines('abc')).toBeNull();
  });
});
