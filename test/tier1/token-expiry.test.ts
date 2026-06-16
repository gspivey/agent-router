/**
 * Tier 1 tests: Token expiry alerting — pure logic.
 * BACKLOG.md § P2.0
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { daysToSeverity, computeDaysRemaining, checkTokenExpiry } from '../../src/token-expiry.js';
import type { Logger } from '../../src/log.js';

describe('daysToSeverity', () => {
  it('returns error when already expired (negative days)', () => {
    expect(daysToSeverity(-1)).toBe('error');
    expect(daysToSeverity(-100)).toBe('error');
  });

  it('returns error at 0 days', () => {
    expect(daysToSeverity(0)).toBe('error');
  });

  it('returns error at 1 day', () => {
    expect(daysToSeverity(1)).toBe('error');
  });

  it('returns error at 2 days', () => {
    expect(daysToSeverity(2)).toBe('error');
  });

  it('returns warn at 3 days', () => {
    expect(daysToSeverity(3)).toBe('warn');
  });

  it('returns warn at 7 days', () => {
    expect(daysToSeverity(7)).toBe('warn');
  });

  it('returns warn at 14 days', () => {
    expect(daysToSeverity(14)).toBe('warn');
  });

  it('returns ok at 15 days', () => {
    expect(daysToSeverity(15)).toBe('ok');
  });

  it('returns ok at 365 days', () => {
    expect(daysToSeverity(365)).toBe('ok');
  });

  // Property: days <= 2 always yields error
  it('property: days <= 2 → error', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 2 }), (days) => {
        expect(daysToSeverity(days)).toBe('error');
      }),
      { numRuns: 100 },
    );
  });

  // Property: 3 <= days <= 14 always yields warn
  it('property: 3 <= days <= 14 → warn', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 14 }), (days) => {
        expect(daysToSeverity(days)).toBe('warn');
      }),
      { numRuns: 100 },
    );
  });

  // Property: days > 14 always yields ok
  it('property: days > 14 → ok', () => {
    fc.assert(
      fc.property(fc.integer({ min: 15, max: 10000 }), (days) => {
        expect(daysToSeverity(days)).toBe('ok');
      }),
      { numRuns: 100 },
    );
  });
});

describe('computeDaysRemaining', () => {
  it('returns 0 for same day', () => {
    const now = new Date('2027-04-25T00:00:00Z');
    const expires = new Date('2027-04-25T12:00:00Z');
    expect(computeDaysRemaining(now, expires)).toBe(0);
  });

  it('returns positive for future expiry', () => {
    const now = new Date('2027-04-11T00:00:00Z');
    const expires = new Date('2027-04-25T00:00:00Z');
    expect(computeDaysRemaining(now, expires)).toBe(14);
  });

  it('returns negative for past expiry', () => {
    const now = new Date('2027-04-27T00:00:00Z');
    const expires = new Date('2027-04-25T00:00:00Z');
    expect(computeDaysRemaining(now, expires)).toBe(-2);
  });

  it('floors partial days', () => {
    const now = new Date('2027-04-24T18:00:00Z');
    const expires = new Date('2027-04-25T06:00:00Z');
    // 12 hours = 0.5 days → floor → 0
    expect(computeDaysRemaining(now, expires)).toBe(0);
  });
});

describe('checkTokenExpiry', () => {
  function createMockLogger(): Logger & { calls: { level: string; msg: string; fields: Record<string, unknown> | null }[] } {
    const calls: { level: string; msg: string; fields: Record<string, unknown> | null }[] = [];
    return {
      calls,
      debug(msg, fields) { calls.push({ level: 'debug', msg, fields: fields ?? null }); },
      info(msg, fields) { calls.push({ level: 'info', msg, fields: fields ?? null }); },
      warn(msg, fields) { calls.push({ level: 'warn', msg, fields: fields ?? null }); },
      error(msg, fields) { calls.push({ level: 'error', msg, fields: fields ?? null }); },
      child() { return this; },
    };
  }

  it('logs warn at 14 days', () => {
    const log = createMockLogger();
    checkTokenExpiry({
      tokenExpiresAt: '2027-04-25T00:00:00Z',
      log,
      now: () => new Date('2027-04-11T00:00:00Z'),
    });
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.level).toBe('warn');
    expect(log.calls[0]!.fields).toMatchObject({ days_remaining: 14 });
  });

  it('logs warn at 7 days', () => {
    const log = createMockLogger();
    checkTokenExpiry({
      tokenExpiresAt: '2027-04-25T00:00:00Z',
      log,
      now: () => new Date('2027-04-18T00:00:00Z'),
    });
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.level).toBe('warn');
    expect(log.calls[0]!.fields).toMatchObject({ days_remaining: 7 });
  });

  it('logs error at 2 days', () => {
    const log = createMockLogger();
    checkTokenExpiry({
      tokenExpiresAt: '2027-04-25T00:00:00Z',
      log,
      now: () => new Date('2027-04-23T00:00:00Z'),
    });
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.level).toBe('error');
    expect(log.calls[0]!.fields).toMatchObject({ days_remaining: 2 });
  });

  it('logs error after expiry', () => {
    const log = createMockLogger();
    checkTokenExpiry({
      tokenExpiresAt: '2027-04-25T00:00:00Z',
      log,
      now: () => new Date('2027-04-27T00:00:00Z'),
    });
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.level).toBe('error');
    expect(log.calls[0]!.fields).toMatchObject({ days_remaining: -2 });
  });

  it('does not log when > 14 days away', () => {
    const log = createMockLogger();
    checkTokenExpiry({
      tokenExpiresAt: '2027-04-25T00:00:00Z',
      log,
      now: () => new Date('2027-01-01T00:00:00Z'),
    });
    expect(log.calls).toHaveLength(0);
  });

  it('logs error for invalid ISO 8601 date', () => {
    const log = createMockLogger();
    checkTokenExpiry({
      tokenExpiresAt: 'not-a-date',
      log,
    });
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.level).toBe('error');
    expect(log.calls[0]!.msg).toContain('Invalid token_expires_at');
  });

  it('sends notification webhook when severity is not ok', () => {
    const log = createMockLogger();
    let posted: unknown = null;
    const fakeFetch = ((_url: unknown, opts: unknown) => {
      posted = JSON.parse((opts as { body: string }).body);
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    checkTokenExpiry({
      tokenExpiresAt: '2027-04-25T00:00:00Z',
      log,
      notifyConfig: { url: 'http://hook.test', events: [] },
      fetch: fakeFetch,
      now: () => new Date('2027-04-23T00:00:00Z'),
    });

    expect(posted).toMatchObject({
      type: 'token_expiry',
      severity: 'error',
      days_remaining: 2,
      expires_at: '2027-04-25T00:00:00Z',
    });
  });

  it('does not send notification webhook when severity is ok', () => {
    const log = createMockLogger();
    let fetched = false;
    const fakeFetch = (() => {
      fetched = true;
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    checkTokenExpiry({
      tokenExpiresAt: '2027-04-25T00:00:00Z',
      log,
      notifyConfig: { url: 'http://hook.test', events: [] },
      fetch: fakeFetch,
      now: () => new Date('2027-01-01T00:00:00Z'),
    });

    expect(fetched).toBe(false);
  });
});
