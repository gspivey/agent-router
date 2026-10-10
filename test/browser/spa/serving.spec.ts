/**
 * SPA serving under /app (spa-overhaul Task 2 / ROADMAP 72).
 *
 * Asserts the daemon-side serving behavior:
 *  - GET /app and GET /app/ return 200 + text/html from the dedicated shell handler.
 *  - A hashed static asset returns 200 with its correct MIME WITHOUT an
 *    Authorization header (static assets are public).
 *  - The direct-loopback shell (bindPublic:false, no proxy proof — the fixture's
 *    config) embeds window.__DAEMON_TOKEN AND carries Cache-Control: no-store.
 *  - GET / and GET /ui still return the legacy UI (migration: untouched).
 *  - An API route (GET /sessions) is handled by the daemon, not the SPA route.
 *
 * Requires `client/dist/` to exist; CI runs `npm run build:client` before the
 * browser tests (per the spec's CI order).
 */
import { test, expect } from '../fixtures.js';

test.describe('SPA serving under /app', () => {
  test('GET /app returns 200 + text/html shell', async ({ page, baseUrl }) => {
    const res = await page.request.get(`${baseUrl}/app`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<div id="app">');
  });

  test('GET /app/ returns 200 + text/html shell', async ({ page, baseUrl }) => {
    const res = await page.request.get(`${baseUrl}/app/`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
  });

  test('direct-loopback shell embeds the token and sets Cache-Control: no-store', async ({ page, baseUrl, token }) => {
    const res = await page.request.get(`${baseUrl}/app`);
    expect(res.status()).toBe(200);
    // The fixture config is bindPublic:false with no trustedProxy, i.e. a direct
    // loopback bind — so embedTokenFor returns the token.
    expect(res.headers()['cache-control']).toBe('no-store');
    const body = await res.text();
    expect(body).toContain(`window.__DAEMON_TOKEN=${JSON.stringify(token)}`);
    // The sentinel must have been replaced.
    expect(body).not.toContain('<!--__DAEMON_TOKEN__-->');
  });

  test('a hashed static asset is served with correct MIME, 200, and no auth required', async ({ page, baseUrl }) => {
    // Discover the hashed JS asset name from the shell rather than hardcoding it.
    const shell = await (await page.request.get(`${baseUrl}/app`)).text();
    const jsMatch = shell.match(/\/app\/assets\/[\w.-]+\.js/);
    expect(jsMatch, 'shell should reference a hashed JS asset under /app/assets/').not.toBeNull();
    const jsPath = jsMatch![0];

    // No Authorization header — assets must be public.
    const res = await page.request.get(`${baseUrl}${jsPath}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('javascript');

    // The CSS asset too.
    const cssMatch = shell.match(/\/app\/assets\/[\w.-]+\.css/);
    expect(cssMatch).not.toBeNull();
    const cssRes = await page.request.get(`${baseUrl}${cssMatch![0]}`);
    expect(cssRes.status()).toBe(200);
    expect(cssRes.headers()['content-type']).toContain('css');
  });

  test('GET / and GET /ui still return the legacy UI during migration', async ({ page, baseUrl }) => {
    const rootRes = await page.request.get(`${baseUrl}/`);
    expect(rootRes.status()).toBe(200);
    const rootBody = await rootRes.text();
    // The legacy server-rendered UI inlines these functions; the SPA shell does not.
    expect(rootBody).toContain('parseHashRoute');
    expect(rootBody).toContain('<!DOCTYPE html>');

    const uiRes = await page.request.get(`${baseUrl}/ui`);
    expect(uiRes.status()).toBe(200);
    const uiBody = await uiRes.text();
    expect(uiBody).toContain('parseHashRoute');
  });

  test('GET /sessions is handled by the daemon API, not the SPA route', async ({ page, baseUrl, token }) => {
    // Without a bearer token the API route rejects with 401 (proving auth
    // middleware runs); the SPA catch-all would instead return HTML/404.
    const unauth = await page.request.get(`${baseUrl}/sessions`);
    expect(unauth.status()).toBe(401);
    const unauthBody = await unauth.json();
    expect(unauthBody.error.code).toBe('unauthorized');

    // With the bearer token it returns the sessions JSON list.
    const authed = await page.request.get(`${baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(authed.status()).toBe(200);
    expect(authed.headers()['content-type']).toContain('application/json');
    const body = await authed.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});
