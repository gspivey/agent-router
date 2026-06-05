import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { renderWebUI } from '../../../src/web-ui.js';

describe('renderWebUI', () => {
  it('returns valid HTML document', () => {
    const html = renderWebUI({ embedToken: false, token: 'test-token' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
  });

  it('embeds token when embedToken is true', () => {
    fc.assert(
      fc.property(
        fc.hexaString({ minLength: 32, maxLength: 64 }),
        (token) => {
          const html = renderWebUI({ embedToken: true, token });
          expect(html).toContain(`window.__DAEMON_TOKEN = '${token}'`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('omits token when embedToken is false', () => {
    fc.assert(
      fc.property(
        fc.hexaString({ minLength: 32, maxLength: 64 }),
        (token) => {
          const html = renderWebUI({ embedToken: false, token });
          expect(html).not.toContain('__DAEMON_TOKEN');
          expect(html).not.toContain(token);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('contains hash-based routing logic', () => {
    const html = renderWebUI({ embedToken: false, token: '' });
    expect(html).toContain('parseHashRoute');
    expect(html).toContain('hashchange');
    expect(html).toContain('list-view');
    expect(html).toContain('detail-view');
  });

  it('contains inlined UI logic functions', () => {
    const html = renderWebUI({ embedToken: false, token: '' });
    expect(html).toContain('mergeEvents');
    expect(html).toContain('trackLastEventId');
    expect(html).toContain('computeBackoff');
    expect(html).toContain('statusToBadge');
    expect(html).toContain('deriveWaitingFor');
  });

  it('contains mobile-responsive meta viewport', () => {
    const html = renderWebUI({ embedToken: false, token: '' });
    expect(html).toContain('viewport');
    expect(html).toContain('width=device-width');
  });
});
