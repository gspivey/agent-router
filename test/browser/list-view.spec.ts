/**
 * List view browser tests.
 * Verifies session rows render with correct status badges and no console errors.
 * Spec: .kiro/specs/browser-test-harness/ · task 5.1
 */
import { test, expect } from './fixtures.js';

test('renders session items with badge on navigation', async ({ page, baseUrl, token, seedSession }) => {
  await seedSession({ live: false, status: 'active' });
  await page.goto(baseUrl);
  const item = page.locator('.session-item').first();
  await expect(item).toBeVisible({ timeout: 5000 });
  await expect(item.locator('.badge')).toBeVisible();
});

test('active session displays badge-green with "active" text', async ({ page, baseUrl, seedSession }) => {
  await seedSession({ live: false, status: 'active' });
  await page.goto(baseUrl);
  const badge = page.locator('.badge-green');
  await expect(badge).toBeVisible({ timeout: 5000 });
  await expect(badge).toHaveText('active');
});

test('completed session displays badge-gray', async ({ page, baseUrl, seedSession }) => {
  await seedSession({ live: false, status: 'completed' });
  await page.goto(baseUrl);
  const badge = page.locator('.badge-gray');
  await expect(badge).toBeVisible({ timeout: 5000 });
  await expect(badge).toHaveText('completed');
});

test('no console errors during list view load', async ({ page, baseUrl, seedSession, console: collector }) => {
  await seedSession({ live: false, status: 'active' });
  await page.goto(baseUrl);
  await page.waitForSelector('.session-item', { timeout: 5000 });
  // Allow time for any async JS errors to surface
  await page.waitForTimeout(200);
  collector.assertNoErrors();
});
