/**
 * Kill session browser tests.
 * Verifies kill confirms, terminates with terminated_web, hides controls.
 * Spec: .kiro/specs/browser-test-harness-v2/ · tasks 12.1, 12.2, 12.3, 12.4, 12.5
 */
import { test, expect } from './fixtures.js';

test('kill button shows confirmation dialog', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({ live: true });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#btn-kill', { timeout: 5000 });

  await page.click('#btn-kill');

  // Confirmation overlay should appear
  await expect(page.locator('.confirm-overlay')).toBeVisible({ timeout: 2000 });
  await expect(page.locator('.confirm-dialog')).toContainText('Kill this session? This cannot be undone.');
  await expect(page.locator('#confirm-kill-yes')).toBeVisible();
  await expect(page.locator('#confirm-kill-no')).toBeVisible();
});

test('cancel in confirmation dialog dismisses without killing', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: true });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#btn-kill', { timeout: 5000 });

  await page.click('#btn-kill');
  await expect(page.locator('.confirm-overlay')).toBeVisible({ timeout: 2000 });

  // Click Cancel
  await page.click('#confirm-kill-no');

  // Overlay should be gone
  await expect(page.locator('.confirm-overlay')).toHaveCount(0);

  // Session should still be active
  const meta = sessionFiles.readMeta(sessionId);
  expect(meta.status).toBe('active');
});

test('confirm kill terminates session with terminated_web', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: true });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#btn-kill', { timeout: 5000 });

  await page.click('#btn-kill');
  await expect(page.locator('.confirm-overlay')).toBeVisible({ timeout: 2000 });

  // Confirm kill
  await page.click('#confirm-kill-yes');

  // Wait for controls to hide
  await expect(page.locator('.controls')).toBeHidden({ timeout: 5000 });

  // Verify session terminated correctly
  const meta = sessionFiles.readMeta(sessionId);
  expect(meta.status).toBe('abandoned');
  expect(meta.termination_reason).toBe('terminated_web');
});

test('controls are hidden after successful kill', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({ live: true });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#btn-kill', { timeout: 5000 });

  // Verify controls are visible initially
  await expect(page.locator('.controls')).toBeVisible();

  await page.click('#btn-kill');
  await expect(page.locator('.confirm-overlay')).toBeVisible({ timeout: 2000 });
  await page.click('#confirm-kill-yes');

  // Controls should be hidden after kill
  await expect(page.locator('.controls')).toBeHidden({ timeout: 5000 });
  // Textarea and buttons should not be interactable
  await expect(page.locator('#prompt-input')).toBeHidden({ timeout: 1000 });
  await expect(page.locator('#btn-send')).toBeHidden({ timeout: 1000 });
  await expect(page.locator('#btn-kill')).toBeHidden({ timeout: 1000 });
});

test('kill failure shows error alert and keeps controls visible', async ({ page, baseUrl, seedSession, console: collector }) => {
  const { sessionId } = await seedSession({ live: true });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#btn-kill', { timeout: 5000 });

  // Intercept the kill request to simulate a server error
  await page.route(`**/sessions/${sessionId}/kill`, (route) => {
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal_error', message: 'Kill failed internally' } }),
    });
  });

  // Click kill and confirm
  await page.click('#btn-kill');
  await expect(page.locator('.confirm-overlay')).toBeVisible({ timeout: 2000 });
  await page.click('#confirm-kill-yes');

  // Alert should fire with failure message
  await page.waitForTimeout(1000);
  expect(collector.dialogs.length).toBeGreaterThan(0);
  expect(collector.dialogs[0]).toContain('Kill failed');

  // Controls should still be visible (not hidden on failure)
  await expect(page.locator('.controls')).toBeVisible();
});
