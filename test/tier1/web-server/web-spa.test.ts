/**
 * Unit tests for the SPA-serving pure helpers (spa-overhaul Task 2 / ROADMAP 72).
 *
 * Covers `isDevMode`, `embedTokenFor` (all 4 combinations of
 * bindPublic × hasProxyProof), and `injectToken`.
 */
import { describe, it, expect } from 'vitest';
import type { Context } from 'hono';
import { isDevMode, embedTokenFor, injectToken, type SpaServingDeps } from '../../../src/web-spa.js';

const noopLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as SpaServingDeps['log'];

function makeDeps(over: Partial<SpaServingDeps>): SpaServingDeps {
  return {
    log: noopLog,
    token: 'tok-abc',
    bindPublic: false,
    hasProxyProof: () => false,
    ...over,
  };
}

// A minimal Context stand-in; embedTokenFor only passes it to hasProxyProof.
const fakeCtx = {} as Context;

describe('isDevMode', () => {
  it('is true only for exactly "development"', () => {
    expect(isDevMode('development')).toBe(true);
  });

  it('is false for production, undefined, test, and other values', () => {
    expect(isDevMode('production')).toBe(false);
    expect(isDevMode(undefined)).toBe(false);
    expect(isDevMode('test')).toBe(false);
    expect(isDevMode('')).toBe(false);
    expect(isDevMode('Development')).toBe(false);
  });
});

describe('embedTokenFor', () => {
  it('returns the token ONLY for a direct loopback bind (bindPublic:false, no proxy proof)', () => {
    const deps = makeDeps({ bindPublic: false, hasProxyProof: () => false });
    expect(embedTokenFor(fakeCtx, deps)).toBe('tok-abc');
  });

  it('returns null for a public bind without proxy proof', () => {
    const deps = makeDeps({ bindPublic: true, hasProxyProof: () => false });
    expect(embedTokenFor(fakeCtx, deps)).toBeNull();
  });

  it('returns null for a loopback bind WITH proxy proof (proxied/tunnel request)', () => {
    const deps = makeDeps({ bindPublic: false, hasProxyProof: () => true });
    expect(embedTokenFor(fakeCtx, deps)).toBeNull();
  });

  it('returns null for a public bind WITH proxy proof', () => {
    const deps = makeDeps({ bindPublic: true, hasProxyProof: () => true });
    expect(embedTokenFor(fakeCtx, deps)).toBeNull();
  });

  it('passes the real token value through when embedding', () => {
    const deps = makeDeps({ token: 'deadbeefcafe', bindPublic: false, hasProxyProof: () => false });
    expect(embedTokenFor(fakeCtx, deps)).toBe('deadbeefcafe');
  });

  it('returns null when the daemon has no token even on a loopback bind', () => {
    const deps = makeDeps({ token: null, bindPublic: false, hasProxyProof: () => false });
    expect(embedTokenFor(fakeCtx, deps)).toBeNull();
  });
});

describe('injectToken', () => {
  const shell = '<head><!--__DAEMON_TOKEN__--></head>';

  it('strips the sentinel (empty) when token is null', () => {
    const out = injectToken(shell, null);
    expect(out).toBe('<head></head>');
    expect(out).not.toContain('__DAEMON_TOKEN');
  });

  it('injects a script assigning window.__DAEMON_TOKEN when a token is present', () => {
    const out = injectToken(shell, 'tok-abc');
    expect(out).toContain('<script>window.__DAEMON_TOKEN="tok-abc"</script>');
    expect(out).not.toContain('<!--__DAEMON_TOKEN__-->');
  });

  it('escapes special characters via JSON.stringify so the script stays safe', () => {
    const nasty = 'a"b\\c</script>';
    const out = injectToken(shell, nasty);
    // JSON.stringify escapes the quote and backslash; the raw unescaped sequence
    // must not appear verbatim as an attribute-breaking payload.
    expect(out).toContain(`window.__DAEMON_TOKEN=${JSON.stringify(nasty)}`);
    expect(out).not.toContain('"a"b\\c');
  });
});
