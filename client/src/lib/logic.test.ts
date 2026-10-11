import { describe, it, expect } from 'vitest';
import { statusToBadge, parseHashRoute, formatDuration, prUrl } from '@shared/logic';

// Smoke test: proves the @shared/logic Vite/Vitest alias resolves to the
// repo-root pure logic module and that it is consumable from the client tree.
describe('shared logic alias', () => {
  it('resolves statusToBadge from @shared/logic', () => {
    expect(statusToBadge('active')).toBe('green');
    expect(statusToBadge('completed')).toBe('gray');
    expect(statusToBadge('abandoned')).toBe('yellow');
    expect(statusToBadge('failed')).toBe('red');
  });

  it('resolves parseHashRoute from @shared/logic', () => {
    expect(parseHashRoute('#/')).toEqual({ view: 'list' });
    expect(parseHashRoute('#/sessions/abc')).toEqual({ view: 'detail', sessionId: 'abc' });
  });

  it('parses #/config as the config view (spa-operator-restoration A-5)', () => {
    expect(parseHashRoute('#/config')).toEqual({ view: 'config' });
    expect(parseHashRoute('#/config/')).toEqual({ view: 'list' });
  });
});

describe('formatDuration (A-3)', () => {
  it('returns the empty string for non-positive inputs', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(-5)).toBe('');
  });

  it('formats sub-hour durations as "Xm"', () => {
    expect(formatDuration(780)).toBe('13m');
  });

  it('formats whole hours as "Xh"', () => {
    expect(formatDuration(3600)).toBe('1h');
  });

  it('formats hour+minute durations as "Xh Ym"', () => {
    expect(formatDuration(3900)).toBe('1h 5m');
  });
});

describe('prUrl (A-3)', () => {
  it('builds a GitHub PR URL from repo and pr number', () => {
    expect(prUrl('gspivey/agent-router', 42)).toBe(
      'https://github.com/gspivey/agent-router/pull/42',
    );
  });
});
