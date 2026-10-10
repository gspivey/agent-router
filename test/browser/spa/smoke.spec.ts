/**
 * SPA cutover smoke flow (spa-overhaul Task 8 / ROADMAP 78).
 *
 * After the cutover `/`, `/ui`, and `/app` all serve the SPA. This smoke spec
 * drives the full operator flow end-to-end against a real Hono daemon (shared
 * fixture) at both the mobile and desktop viewports (Req 9.3; NFR-4.1):
 *
 *   session list  →  open a session  →  chat view renders.
 *
 * It also asserts the cutover itself (Req 9.5): the SPA is the response for
 * `GET /`, `GET /ui`, and `GET /app` with HTTP 200. The deep link here uses the
 * post-cutover root path (`/?token=…#/`) rather than `/app`, exercising the
 * rewired `/` route end-to-end in a browser.
 *
 * Requires `client/dist/` to exist; CI runs `npm run build:client` before the
 * browser tests (per the spec's CI order).
 */
import { test, expect } from '../fixtures.js';

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** A minimal chat history so the opened session renders at least one bubble. */
const HISTORY: Array<Record<string, unknown>> = [
  { source: 'router', type: 'session_started' },
  {
    source: 'agent',
    type: 'session/update',
    update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hello operator' } },
  },
];

test.describe('SPA cutover smoke flow', () => {
  test('GET /, GET /ui, GET /app all return the SPA shell (200) (Req 9.5)', async ({
    page,
    baseUrl,
  }) => {
    for (const path of ['/', '/ui', '/app']) {
      const res = await page.request.get(`${baseUrl}${path}`);
      expect(res.status(), `${path} should return 200`).toBe(200);
      expect(res.headers()['content-type'], `${path} should be text/html`).toContain('text/html');
      const body = await res.text();
      expect(body, `${path} should render the SPA mount point`).toContain('<div id="app">');
      expect(body, `${path} should reference the hashed SPA bundle`).toMatch(
        /\/app\/assets\/[\w.-]+\.js/,
      );
    }
  });

  for (const vp of VIEWPORTS) {
    test(`full flow list → open → chat at ${vp.name} (${vp.width}px) (Req 9.3)`, async ({
      page,
      baseUrl,
      token,
      seedSession,
    }) => {
      // Seed two sessions so the list is non-trivial; open the one with history.
      await seedSession({ status: 'active', repo: 'org/other' });
      const { sessionId } = await seedSession({
        status: 'completed',
        repo: 'org/smoke',
        streamEntries: HISTORY,
      });

      await page.setViewportSize({ width: vp.width, height: vp.height });

      // Load the SPA from the post-cutover root path (`/`), not `/app`.
      await page.goto(`${baseUrl}/?token=${token}#/`);

      // 1. Session list renders.
      await expect(page.getByTestId('app-header')).toContainText('Sessions');
      await expect(page.getByTestId('session-card')).toHaveCount(2);

      // 2. Open the seeded-with-history session by activating its card.
      await page.getByTestId('session-card').filter({ hasText: 'org/smoke' }).first().click();
      await expect(page).toHaveURL(new RegExp(`#/sessions/${sessionId}$`));

      // 3. Chat view renders with the agent bubble from history.
      await expect(page.getByTestId('chat-view')).toBeVisible();
      await expect(page.getByTestId('chat-loading')).toHaveCount(0);
      await expect(page.getByText('Hello operator')).toBeVisible();

      await page.screenshot({ path: `test-results/spa-smoke-${vp.name}.png`, fullPage: true });
    });
  }
});
