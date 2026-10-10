/**
 * SPA authentication flow (spa-overhaul Task 3 / ROADMAP 73).
 *
 * AUTH ONLY — end-to-end SSE browser tests are deferred to Task 6 (per HIGH-7).
 * The SSE client logic is covered by the vitest unit tests
 * (`client/src/lib/sse.test.ts`). Here we drive a real Hono server and the built
 * SPA shell under `/app` and assert the Requirement 3.1–3.4 / 3.7 behaviors:
 *
 *   - a `?token` query param is captured, stored, and stripped from the URL bar;
 *   - a fresh `?token` overwrites a stale stored token;
 *   - authenticated API requests carry `Authorization: Bearer <token>`;
 *   - a stored-token second visit (no `?token`, no injected token) succeeds;
 *   - a 401/403 shows the "expired" state and clears the stored token.
 *
 * Requires `client/dist/` to exist; CI runs `npm run build:client` before the
 * browser tests.
 */
import { test, expect } from '../fixtures.js';

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/**
 * Serve the `/app` shell with the server-injected `window.__DAEMON_TOKEN`
 * removed, so the SPA must fall back to the URL `?token` or `localStorage`.
 * Everything else (assets, API) passes through to the real daemon.
 */
async function stripEmbeddedToken(page: import('@playwright/test').Page, baseUrl: string): Promise<void> {
  await page.route(`${baseUrl}/app`, async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    body = body.replace(/<script>window\.__DAEMON_TOKEN=.*?<\/script>/s, '');
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body,
    });
  });
}

test.describe('SPA auth flow', () => {
  test('?token is captured, persisted, and stripped from the URL bar (Req 3.1)', async ({ page, baseUrl, token }) => {
    await page.goto(`${baseUrl}/app?token=${token}#/`);
    // The authed state renders once the probe runs with the resolved token.
    await expect(page.getByTestId('authed')).toBeVisible();

    // ?token removed from the address bar; hash preserved.
    expect(page.url()).not.toContain('token=');
    expect(page.url()).toContain('#/');

    const stored = await page.evaluate(() => localStorage.getItem('ar_token'));
    expect(stored).toBe(token);
  });

  test('a fresh ?token overwrites a stale stored token (Req 3.2)', async ({ page, baseUrl, token }) => {
    await stripEmbeddedToken(page, baseUrl);
    await page.addInitScript(() => localStorage.setItem('ar_token', 'STALE-TOKEN'));

    await page.goto(`${baseUrl}/app?token=${token}`);
    await expect(page.getByTestId('authed')).toBeVisible();

    const stored = await page.evaluate(() => localStorage.getItem('ar_token'));
    expect(stored).toBe(token);
    expect(stored).not.toBe('STALE-TOKEN');
  });

  test('authenticated API requests carry Authorization: Bearer (Req 3.3)', async ({ page, baseUrl, token }) => {
    const authHeaders: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/sessions')) {
        const h = req.headers()['authorization'];
        if (h) authHeaders.push(h);
      }
    });

    await page.goto(`${baseUrl}/app?token=${token}`);
    await expect(page.getByTestId('authed')).toHaveAttribute('data-probe', 'ok');

    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders[0]).toBe(`Bearer ${token}`);
  });

  test('a stored-token second visit succeeds with HTTP 200 (Req 3.7)', async ({ page, baseUrl, token }) => {
    // No ?token and no injected token — only the previously stored value.
    await stripEmbeddedToken(page, baseUrl);
    await page.addInitScript((t) => localStorage.setItem('ar_token', t), token);

    await page.goto(`${baseUrl}/app`);

    const authed = page.getByTestId('authed');
    await expect(authed).toBeVisible();
    await expect(authed).toHaveAttribute('data-probe', 'ok');
  });

  test('no token available renders the auth-error (missing) state (Req 3.5)', async ({ page, baseUrl }) => {
    await stripEmbeddedToken(page, baseUrl);
    // Ensure no stored token.
    await page.addInitScript(() => localStorage.removeItem('ar_token'));

    await page.goto(`${baseUrl}/app`);

    const err = page.getByTestId('auth-error');
    await expect(err).toBeVisible();
    await expect(err).toHaveAttribute('data-auth-state', 'missing');
  });

  test('a 401 shows the expired state and clears the stored token (Req 3.4)', async ({ page, baseUrl, token }) => {
    // Force the sessions probe to fail with 401.
    await page.route(`${baseUrl}/sessions*`, (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unauthorized' } }) }),
    );

    await page.goto(`${baseUrl}/app?token=${token}`);

    const err = page.getByTestId('auth-error');
    await expect(err).toBeVisible();
    await expect(err).toHaveAttribute('data-auth-state', 'expired');
    await expect(page.getByTestId('reload-button')).toBeVisible();

    // The lockout cleared the stored token (Req 3.4).
    const stored = await page.evaluate(() => localStorage.getItem('ar_token'));
    expect(stored).toBeNull();
  });

  test('a 403 also triggers the expired lockout (Req 3.4)', async ({ page, baseUrl, token }) => {
    await page.route(`${baseUrl}/sessions*`, (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forbidden' } }) }),
    );

    await page.goto(`${baseUrl}/app?token=${token}`);

    await expect(page.getByTestId('auth-error')).toHaveAttribute('data-auth-state', 'expired');
  });

  for (const vp of VIEWPORTS) {
    test(`auth-error state renders at ${vp.name} (${vp.width}px)`, async ({ page, baseUrl }) => {
      await stripEmbeddedToken(page, baseUrl);
      await page.addInitScript(() => localStorage.removeItem('ar_token'));
      await page.setViewportSize({ width: vp.width, height: vp.height });

      await page.goto(`${baseUrl}/app`);

      await expect(page.getByTestId('auth-error')).toBeVisible();
      await page.screenshot({ path: `test-results/spa-auth-missing-${vp.name}.png` });
    });
  }
});
