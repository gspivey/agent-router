import { describe, it, expect } from 'vitest';
import { renderWebUI } from '../../../src/web-ui.js';

describe('renderWebUI detail view features', () => {
  const html = renderWebUI({ embedToken: true, token: 'test-token-123' });

  it('contains detail view SSE client with fetch-based streaming', () => {
    expect(html).toContain('connectSSE');
    expect(html).toContain('/sessions/');
    expect(html).toContain('/stream');
    expect(html).toContain('Last-Event-ID');
  });

  it('contains exponential backoff reconnection logic', () => {
    expect(html).toContain('scheduleReconnect');
    expect(html).toContain('computeBackoff');
  });

  it('reconnects on visibilitychange', () => {
    expect(html).toContain('visibilitychange');
    expect(html).toContain('visibilityState');
  });

  it('contains prompt injection textarea with max 10000 chars', () => {
    expect(html).toContain('prompt-input');
    expect(html).toContain('maxlength="10000"');
    expect(html).toContain('rows="3"');
  });

  it('contains Stop button with amber styling', () => {
    expect(html).toContain('btn-stop');
    expect(html).toContain('>Stop<');
    expect(html).toContain('#9e6a03'); // amber color
  });

  it('contains Kill button with red styling and confirmation dialog', () => {
    expect(html).toContain('btn-kill');
    expect(html).toContain('>Kill<');
    expect(html).toContain('#da3633'); // red color
    expect(html).toContain('confirm-overlay');
    expect(html).toContain('Kill this session? This cannot be undone.');
  });

  it('hides write controls for non-active sessions', () => {
    expect(html).toContain("meta.status !== 'active'");
    expect(html).toContain('hideControls');
  });

  it('contains mobile CSS with min 44x44px tap targets', () => {
    expect(html).toContain('min-width:44px');
    expect(html).toContain('min-height:44px');
  });

  it('contains 16px body font and single-column at 480px', () => {
    expect(html).toContain('font-size:16px');
    expect(html).toContain('max-width:480px');
  });

  it('contains 14px min log font at 768px and horizontally scrollable log container', () => {
    expect(html).toContain('max-width:768px');
    expect(html).toContain('font-size:14px');
    expect(html).toContain('overflow-x:auto');
  });

  it('contains PR deep links to GitHub in detail view', () => {
    expect(html).toContain('https://github.com/');
    expect(html).toContain('/pull/');
  });

  it('contains session metadata rendering', () => {
    expect(html).toContain('renderDetailMeta');
    expect(html).toContain('detail-meta');
    expect(html).toContain('session_id');
  });
});
