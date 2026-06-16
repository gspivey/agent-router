import { describe, it, expect } from 'vitest';
import { buildHealthResponse } from '../../src/health.js';

describe('buildHealthResponse', () => {
  const baseState = {
    startedAtMs: 1000,
    nowMs: 61_000,
    activeSessionCount: 3,
    dbOk: true,
  };

  it('returns 200 with correct shape when DB is ok', () => {
    const result = buildHealthResponse(baseState);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: 'ok',
      uptime_seconds: 60,
      active_sessions: 3,
      db_ok: true,
    });
  });

  it('returns 503 when DB is unreachable', () => {
    const result = buildHealthResponse({ ...baseState, dbOk: false });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      status: 'degraded',
      uptime_seconds: 60,
      active_sessions: 3,
      db_ok: false,
    });
  });

  it('computes uptime_seconds as floor of (nowMs - startedAtMs) / 1000', () => {
    const result = buildHealthResponse({ ...baseState, nowMs: 1500 });
    expect(result.body.uptime_seconds).toBe(0);
  });

  it('handles zero active sessions', () => {
    const result = buildHealthResponse({ ...baseState, activeSessionCount: 0 });
    expect(result.body.active_sessions).toBe(0);
  });
});
