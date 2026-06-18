import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  validateOffset,
  paginateSessions,
  getLastStreamEntryType,
} from '../../../src/web-routes.js';
import type { SessionMeta } from '../../../src/session-files.js';

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: crypto.randomUUID(),
    original_prompt: 'test',
    status: 'completed',
    created_at: Math.floor(Date.now() / 1000),
    completed_at: null,
    prs: [],
    ...overrides,
  };
}

describe('validateOffset', () => {
  it('accepts non-negative integers', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100000 }), (n) => {
        expect(validateOffset(String(n))).toBe(n);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects negative or non-integer values', () => {
    expect(validateOffset('-1')).toBeNull();
    expect(validateOffset('abc')).toBeNull();
    expect(validateOffset('1.5')).toBeNull();
  });
});

describe('paginateSessions', () => {
  const noWaiting = () => undefined;

  it('active sessions always appear regardless of offset', () => {
    const active1 = makeMeta({ status: 'active', created_at: 100 });
    const active2 = makeMeta({ status: 'active', created_at: 99 });
    const completed = Array.from({ length: 30 }, (_, i) =>
      makeMeta({ status: 'completed', created_at: 50 - i }),
    );
    const all = [active1, active2, ...completed];

    // Even at offset=10, active sessions still appear
    const result = paginateSessions(all, undefined, undefined, 5, 10, noWaiting);
    const activeInResult = result.sessions.filter(s => s.status === 'active');
    expect(activeInResult.length).toBe(2);
  });

  it('non-active sessions paginate with offset/limit', () => {
    const completed = Array.from({ length: 10 }, (_, i) =>
      makeMeta({ session_id: `id-${i}`, status: 'completed', created_at: 100 - i }),
    );

    const page1 = paginateSessions(completed, undefined, undefined, 3, 0, noWaiting);
    expect(page1.sessions.length).toBe(3);
    expect(page1.total).toBe(10);

    const page2 = paginateSessions(completed, undefined, undefined, 3, 3, noWaiting);
    expect(page2.sessions.length).toBe(3);
    expect(page2.sessions[0]!.session_id).toBe('id-3');
  });

  it('status filter applies simple pagination without active-always rule', () => {
    const active = makeMeta({ status: 'active', created_at: 200 });
    const completed = Array.from({ length: 5 }, (_, i) =>
      makeMeta({ status: 'completed', created_at: 100 - i }),
    );
    const all = [active, ...completed];

    const result = paginateSessions(all, 'completed', undefined, 3, 0, noWaiting);
    expect(result.sessions.every(s => s.status === 'completed')).toBe(true);
    expect(result.total).toBe(5);
  });

  it('since filter works', () => {
    const sessions = [
      makeMeta({ status: 'completed', created_at: 200 }),
      makeMeta({ status: 'completed', created_at: 100 }),
      makeMeta({ status: 'completed', created_at: 50 }),
    ];

    const result = paginateSessions(sessions, undefined, 100, 10, 0, noWaiting);
    expect(result.total).toBe(2);
    expect(result.sessions.length).toBe(2);
  });

  it('includes waiting_for from waitingForFn', () => {
    const active = makeMeta({ status: 'active', session_id: 'aaa' });
    const completed = makeMeta({ status: 'completed', session_id: 'bbb' });

    const waitingFn = (m: SessionMeta) => m.status === 'active' ? 'waiting: tool' : undefined;
    const result = paginateSessions([active, completed], undefined, undefined, 10, 0, waitingFn);

    const activeSession = result.sessions.find(s => s.session_id === 'aaa');
    const completedSession = result.sessions.find(s => s.session_id === 'bbb');
    expect(activeSession!.waiting_for).toBe('waiting: tool');
    expect(completedSession!.waiting_for).toBeNull();
  });

  it('property: total equals filtered count regardless of pagination', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            session_id: fc.uuid(),
            original_prompt: fc.constant('test'),
            status: fc.constantFrom('active' as const, 'completed' as const, 'abandoned' as const, 'failed' as const),
            created_at: fc.integer({ min: 0, max: 2000000000 }),
            completed_at: fc.constant(null),
            prs: fc.constant([]),
          }),
          { maxLength: 30 },
        ),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 50 }),
        (sessions, offset, limit) => {
          const metas = sessions as SessionMeta[];
          const result = paginateSessions(metas, undefined, undefined, limit, offset, noWaiting);
          expect(result.total).toBe(metas.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: active sessions always in result when no status filter', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            session_id: fc.uuid(),
            original_prompt: fc.constant('test'),
            status: fc.constantFrom('active' as const, 'completed' as const, 'abandoned' as const, 'failed' as const),
            created_at: fc.integer({ min: 0, max: 2000000000 }),
            completed_at: fc.constant(null),
            prs: fc.constant([]),
          }),
          { maxLength: 30 },
        ),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 1, max: 20 }),
        (sessions, offset, limit) => {
          const metas = sessions as SessionMeta[];
          const result = paginateSessions(metas, undefined, undefined, limit, offset, noWaiting);
          const activeCount = metas.filter(m => m.status === 'active').length;
          const activeInResult = result.sessions.filter(s => s.status === 'active').length;
          expect(activeInResult).toBe(activeCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('getLastStreamEntryType', () => {
  it('returns undefined for non-existent file', () => {
    expect(getLastStreamEntryType('/nonexistent/path/stream.log')).toBeUndefined();
  });

  it('returns undefined for empty file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-test-'));
    const filePath = path.join(tmpDir, 'stream.log');
    fs.writeFileSync(filePath, '');
    expect(getLastStreamEntryType(filePath)).toBeUndefined();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the type of the last entry', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-test-'));
    const filePath = path.join(tmpDir, 'stream.log');
    fs.writeFileSync(filePath, [
      JSON.stringify({ ts: '2024-01-01', source: 'agent', type: 'agent_message' }),
      JSON.stringify({ ts: '2024-01-02', source: 'agent', type: 'tool_call' }),
    ].join('\n') + '\n');
    expect(getLastStreamEntryType(filePath)).toBe('tool_call');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips trailing empty lines', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-test-'));
    const filePath = path.join(tmpDir, 'stream.log');
    fs.writeFileSync(filePath, JSON.stringify({ ts: '2024-01-01', source: 'agent', type: 'prompt_injected' }) + '\n\n\n');
    expect(getLastStreamEntryType(filePath)).toBe('prompt_injected');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
