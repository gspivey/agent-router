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

describe('first_event_id / last_event_id derivation (broker raw line numbers)', () => {
  it('returns null ids for an empty / missing stream', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ids-empty-'));
    const streamPath = path.join(tmpDir, 'stream.log');
    fs.writeFileSync(streamPath, '');
    const result = tailStreamLog(streamPath, 200);
    expect(result.entries.length).toBe(0);
    expect(result.first_event_id).toBeNull();
    expect(result.last_event_id).toBeNull();
    // Missing file
    const missing = tailStreamLog(path.join(tmpDir, 'nope.log'), 200);
    expect(missing.first_event_id).toBeNull();
    expect(missing.last_event_id).toBeNull();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('ids are raw 1-indexed line numbers of first/last valid entries (all valid)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ids-valid-'));
    const streamPath = path.join(tmpDir, 'stream.log');
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ ts: `2025-01-01T00:00:${String(i).padStart(2, '0')}Z`, source: 'router', type: `t${i}` }),
    );
    fs.writeFileSync(streamPath, lines.join('\n') + '\n');

    const full = tailStreamLog(streamPath, 2000);
    expect(full.entries.length).toBe(10);
    expect(full.first_event_id).toBe(1);
    expect(full.last_event_id).toBe(10);

    // A window of the last 3 lines: broker ids are the raw line numbers 8,9,10.
    const windowed = tailStreamLog(streamPath, 3);
    expect(windowed.entries.length).toBe(3);
    expect(windowed.first_event_id).toBe(8);
    expect(windowed.last_event_id).toBe(10);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('malformed lines consume a broker id (ids NOT equal to valid-entry positions)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ids-malformed-'));
    const streamPath = path.join(tmpDir, 'stream.log');
    // Line 1: valid, line 2: malformed, line 3: valid, line 4: malformed, line 5: valid.
    const lines = [
      JSON.stringify({ ts: '2025-01-01T00:00:00Z', source: 'router', type: 'a' }),
      'not json',
      JSON.stringify({ ts: '2025-01-01T00:00:02Z', source: 'router', type: 'b' }),
      '{broken',
      JSON.stringify({ ts: '2025-01-01T00:00:04Z', source: 'router', type: 'c' }),
    ];
    fs.writeFileSync(streamPath, lines.join('\n') + '\n');

    const result = tailStreamLog(streamPath, 2000);
    expect(result.entries.length).toBe(3);
    expect(result.skipped_lines).toBe(2);
    // First valid entry is raw line 1; last valid entry is raw line 5.
    expect(result.first_event_id).toBe(1);
    expect(result.last_event_id).toBe(5);
    // Prove the id is NOT skipped_lines + entries.length (= 5 here by coincidence of
    // this fixture would be 2+3=5; use an asymmetric fixture below to disambiguate).
  });

  it('last_event_id is NOT skipped_lines + entries.length when malformed lines trail', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ids-trail-'));
    const streamPath = path.join(tmpDir, 'stream.log');
    // 3 valid lines then 2 trailing malformed lines. Last VALID entry is raw line 3.
    const lines = [
      JSON.stringify({ ts: '2025-01-01T00:00:00Z', source: 'router', type: 'a' }),
      JSON.stringify({ ts: '2025-01-01T00:00:01Z', source: 'router', type: 'b' }),
      JSON.stringify({ ts: '2025-01-01T00:00:02Z', source: 'router', type: 'c' }),
      'garbage-1',
      'garbage-2',
    ];
    fs.writeFileSync(streamPath, lines.join('\n') + '\n');

    const result = tailStreamLog(streamPath, 2000);
    expect(result.entries.length).toBe(3);
    expect(result.skipped_lines).toBe(2);
    expect(result.first_event_id).toBe(1);
    expect(result.last_event_id).toBe(3);
    // skipped_lines + entries.length === 5, but last_event_id === 3. They differ.
    expect(result.last_event_id).not.toBe(result.skipped_lines + result.entries.length);

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
