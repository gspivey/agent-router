import { describe, it, expect } from 'vitest';
import { statusToBadge, parseHashRoute } from '@shared/logic';

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
});
