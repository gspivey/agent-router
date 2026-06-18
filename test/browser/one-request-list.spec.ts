/**
 * Browser test: one-request session list (ROADMAP #27, task 2.2).
 * Verifies: exactly one /sessions request, zero /sessions/<id> follow-ups on list render.
 */
import { test, expect } from './fixtures.js';

test('list view issues exactly one /sessions request and zero per-row fetches', async ({ page, baseUrl, seedSession }) => {
  // Seed some sessions
  await seedSession({ live: false, status: 'active' });
  await seedSession({ live: false, status: 'completed' });
  await seedSession({ live: false, status: 'completed' });

  const requestUrls: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/sessions')) {
      requestUrls.push(url.pathname + url.search);
    }
  });

  await page.goto(baseUrl);
  await page.waitForSelector('.session-item', { timeout: 5000 });
  // Wait a bit to ensure no follow-up requests are issued
  await page.waitForTimeout(500);

  // Exactly one /sessions request (the list)
  const listRequests = requestUrls.filter(u => /^\/sessions(\?|$)/.test(u));
  expect(listRequests.length).toBe(1);

  // Zero /sessions/<id> requests (no per-row follow-ups)
  const detailRequests = requestUrls.filter(u => /^\/sessions\/[^?]/.test(u));
  expect(detailRequests.length).toBe(0);
});

test('list view renders waiting_for from server response', async ({ page, baseUrl, seedSession }) => {
  await seedSession({ live: false, status: 'active', streamEntries: [{ type: 'tool_call' }] });
  await page.goto(baseUrl);
  await page.waitForSelector('.session-item', { timeout: 5000 });
  const waitingEl = page.locator('.session-waiting');
  await expect(waitingEl).toBeVisible({ timeout: 3000 });
  await expect(waitingEl).toContainText('waiting: tool');
});

test('pagination controls appear when sessions exceed page size', async ({ page, baseUrl, seedSession }) => {
  // Seed more sessions than the page size (20) — the actual page size for the
  // paginated endpoint is 20, so 25 non-active + any active sessions should trigger
  for (let i = 0; i < 22; i++) {
    await seedSession({ live: false, status: 'completed' });
  }
  await page.goto(baseUrl);
  await page.waitForSelector('.session-item', { timeout: 5000 });
  const pagination = page.locator('.pagination');
  await expect(pagination).toBeVisible({ timeout: 3000 });
});
