/**
 * Detail view browser tests.
 * Verifies hash-based routing: row click → detail, not-found state, back to list.
 * Spec: .kiro/specs/browser-test-harness/ · task 6.1
 */
import { test, expect } from './fixtures.js';

test('clicking session row navigates to detail view via hash route', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });
  await page.goto(baseUrl);
  await page.waitForSelector('.session-item', { timeout: 5000 });

  await page.locator('.session-item').first().click();

  await expect(page).toHaveURL(new RegExp(`#/sessions/${sessionId}`));
  await expect(page.locator('#list-view')).toBeHidden();
  await expect(page.locator('#detail-view')).toBeVisible();
});

test('detail view displays session metadata', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active', repo: 'test-org/test-repo' });
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);

  // Badge
  await expect(page.locator('.badge-green')).toBeVisible({ timeout: 5000 });
  // Repo name
  await expect(page.locator('.detail-meta')).toContainText('test-org/test-repo');
  // Full session ID
  await expect(page.locator('.detail-meta')).toContainText(sessionId);
  // Creation timestamp (just verify the "Created:" label exists)
  await expect(page.locator('.detail-meta')).toContainText('Created:');
});

test('non-existent session shows "Session not found" with back link', async ({ page, baseUrl }) => {
  await page.goto(`${baseUrl}#/sessions/00000000-0000-0000-0000-000000000000`);

  await expect(page.locator('#detail-view')).toContainText('Session not found', { timeout: 5000 });
  const backLink = page.locator('#detail-view a[href="#/"]');
  await expect(backLink).toBeVisible();
});

test('navigating to #/ returns to list view', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });
  // Start at detail view
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await expect(page.locator('#detail-view')).toBeVisible({ timeout: 5000 });

  // Navigate back to list
  await page.goto(`${baseUrl}#/`);
  await expect(page.locator('#list-view')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#detail-view')).toBeHidden();
});
