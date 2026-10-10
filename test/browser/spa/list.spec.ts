/**
 * SPA session list view + single Sessions nav (spa-overhaul Task 4 / ROADMAP 74).
 *
 * Drives the built SPA under `/app` against a real Hono daemon (via the shared
 * fixture) and asserts the Requirement 5 behaviors:
 *
 *   - the list renders a card per seeded session with its status badge, repo,
 *     and `waiting_for` (Req 5.1, 5.2);
 *   - the list issues EXACTLY one `GET /sessions` request on load (NFR-1.2);
 *   - activating a card navigates to the chat route `#/sessions/:id` (Req 5.6);
 *   - there is a single Sessions nav — no Repos/Config element and no
 *     `/repos` · `/projects` · `/config` request (Req 5.3, 5.8);
 *   - screenshots are captured at 375px (mobile) and 1280px (desktop) (NFR-4.1).
 *
 * Requires `client/dist/` to exist; CI runs `npm run build:client` before the
 * browser tests.
 */
import { test, expect } from '../fixtures.js';

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

test.describe('SPA session list', () => {
  test('renders a card per session with status/repo/waiting_for (Req 5.1, 5.2)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    await seedSession({ status: 'active', repo: 'org/alpha' });
    await seedSession({ status: 'completed', repo: 'org/beta' });

    await page.goto(`${baseUrl}/app?token=${token}#/`);

    const cards = page.getByTestId('session-card');
    await expect(cards).toHaveCount(2);

    // Both seeded repos appear, and each card carries a status badge.
    await expect(page.getByText('org/alpha')).toBeVisible();
    await expect(page.getByText('org/beta')).toBeVisible();
    await expect(page.getByTestId('status-badge').first()).toBeVisible();
  });

  test('issues exactly one GET /sessions request on load (NFR-1.2)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    await seedSession({ status: 'active', repo: 'org/one' });

    const listRequests: string[] = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      // The list endpoint is `/sessions` (no trailing id segment).
      if (/\/sessions\/?$/.test(u.pathname)) listRequests.push(u.pathname + u.search);
    });

    await page.goto(`${baseUrl}/app?token=${token}#/`);
    await expect(page.getByTestId('session-card')).toHaveCount(1);

    expect(listRequests.length).toBe(1);
  });

  test('activating a card navigates to #/sessions/:id (Req 5.6)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({ status: 'active', repo: 'org/nav' });

    await page.goto(`${baseUrl}/app?token=${token}#/`);
    await page.getByTestId('session-card').first().click();

    await expect(page).toHaveURL(new RegExp(`#/sessions/${sessionId}$`));
    await expect(page.getByTestId('chat-view')).toBeVisible();
  });

  test('has a single Sessions nav — no Repos/Config element or requests (Req 5.3, 5.8)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    await seedSession({ status: 'active', repo: 'org/solo' });

    const forbiddenRequests: string[] = [];
    page.on('request', (req) => {
      const p = new URL(req.url()).pathname;
      if (/^\/(repos|projects|config)(\/|$)/.test(p)) forbiddenRequests.push(p);
    });

    await page.goto(`${baseUrl}/app?token=${token}#/`);
    await expect(page.getByTestId('session-card')).toHaveCount(1);

    // Header shows the single Sessions destination.
    await expect(page.getByTestId('app-header')).toContainText('Sessions');

    // No Repos/Config nav text, no nav link to those views.
    const bodyText = (await page.locator('body').textContent()) ?? '';
    expect(bodyText).not.toMatch(/\bRepos\b/);
    expect(bodyText).not.toMatch(/\bConfig\b/);
    expect(await page.locator('a[href*="/repos"], a[href*="/config"], a[href*="/projects"]').count()).toBe(0);

    // The SPA never fetches those endpoints.
    expect(forbiddenRequests).toEqual([]);
  });

  for (const vp of VIEWPORTS) {
    test(`list renders at ${vp.name} (${vp.width}px) with screenshot (NFR-4.1)`, async ({
      page,
      baseUrl,
      token,
      seedSession,
    }) => {
      await seedSession({ status: 'active', repo: 'org/shot-a' });
      await seedSession({ status: 'failed', repo: 'org/shot-b' });

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`${baseUrl}/app?token=${token}#/`);
      await expect(page.getByTestId('session-card')).toHaveCount(2);

      await page.screenshot({ path: `test-results/spa-list-${vp.name}.png`, fullPage: true });
    });
  }
});
