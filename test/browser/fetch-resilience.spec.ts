/**
 * Fetch resilience browser tests.
 * Verifies:
 * - Transient failure then recovery → silent retry, list renders
 * - Permanent failure → error state with working Retry button
 * - 401 → auth-specific message, no blind retry
 * - Hung request → timeout, not infinite spinner
 * Spec: .kiro/specs/browser-test-harness-v2/ · tasks 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7
 */
import { test, expect } from './fixtures.js';

test.describe('Fetch resilience: list view', () => {

  test('transient failure then recovery: retries silently and renders list', async ({
    page, baseUrl, seedSession,
  }) => {
    await seedSession({ live: false, status: 'active' });

    let requestCount = 0;
    await page.route('**/sessions?*', async (route) => {
      requestCount++;
      if (requestCount <= 2) {
        // First 2 requests fail with network error
        await route.abort('connectionfailed');
      } else {
        await route.continue();
      }
    });

    await page.goto(baseUrl);
    // Despite 2 failures, the 3rd attempt succeeds and the list renders
    await expect(page.locator('.session-item').first()).toBeVisible({ timeout: 15_000 });
    // No error state visible
    await expect(page.locator('.error-state')).not.toBeVisible();
  });

  test('permanent failure: shows error state with working Retry button', async ({
    page, baseUrl, seedSession,
  }) => {
    await seedSession({ live: false, status: 'active' });

    // All requests fail
    let failCount = 0;
    await page.route('**/sessions?*', async (route) => {
      failCount++;
      await route.abort('connectionfailed');
    });

    await page.goto(baseUrl);
    // After max retries, error state should appear
    await expect(page.locator('.error-state')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.error-state')).toContainText('Failed to load sessions');
    await expect(page.locator('#retry-list-btn')).toBeVisible();

    // Verify retries happened (3 attempts)
    expect(failCount).toBe(3);

    // Now make subsequent requests succeed and click Retry
    await page.unroute('**/sessions?*');
    await page.locator('#retry-list-btn').click();
    await expect(page.locator('.session-item').first()).toBeVisible({ timeout: 15_000 });
  });

  test('401 response: shows auth-specific message, no retry', async ({
    page, baseUrl, seedSession,
  }) => {
    await seedSession({ live: false, status: 'active' });

    let requestCount = 0;
    await page.route('**/sessions?*', async (route) => {
      requestCount++;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Unauthorized' } }),
      });
    });

    await page.goto(baseUrl);
    // Auth error state should appear immediately (no retries)
    await expect(page.locator('.auth-error')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.auth-error')).toContainText('Authentication failed');
    // No Retry button for auth errors
    await expect(page.locator('#retry-list-btn')).not.toBeVisible();
    // Should not have retried — exactly 1 request
    expect(requestCount).toBe(1);
  });

  test('hung request: times out and shows error, not infinite spinner', async ({
    page, baseUrl, seedSession,
  }) => {
    test.setTimeout(90_000);
    await seedSession({ live: false, status: 'active' });

    // Make all requests hang (never respond)
    await page.route('**/sessions?*', async () => {
      // Never call route.fulfill or route.continue — request hangs
      await new Promise(() => {});
    });

    await page.goto(baseUrl);
    // After timeout + retries, should show error state (not "Loading sessions...")
    await expect(page.locator('.error-state')).toBeVisible({ timeout: 75_000 });
    await expect(page.locator('.error-state')).toContainText('timed out');
    // "Loading sessions..." should NOT be visible
    await expect(page.locator('text=Loading sessions')).not.toBeVisible();
  });
});

test.describe('Fetch resilience: detail view', () => {

  test('transient failure then recovery on detail load', async ({
    page, baseUrl, seedSession,
  }) => {
    const { sessionId } = await seedSession({ live: false, status: 'active' });

    let requestCount = 0;
    await page.route(`**/sessions/${sessionId}?*`, async (route) => {
      requestCount++;
      if (requestCount <= 1) {
        await route.abort('connectionfailed');
      } else {
        await route.continue();
      }
    });

    await page.goto(`${baseUrl}#/sessions/${sessionId}`);
    // Despite 1 failure, the retry succeeds and detail renders
    await expect(page.locator('.detail-meta')).toBeVisible({ timeout: 15_000 });
  });

  test('401 on detail view shows auth error', async ({
    page, baseUrl, seedSession,
  }) => {
    const { sessionId } = await seedSession({ live: false, status: 'active' });

    await page.route(`**/sessions/${sessionId}?*`, async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Unauthorized' } }),
      });
    });

    await page.goto(`${baseUrl}#/sessions/${sessionId}`);
    await expect(page.locator('.auth-error')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.auth-error')).toContainText('Authentication failed');
  });

  test('permanent failure on detail shows Retry button', async ({
    page, baseUrl, seedSession,
  }) => {
    const { sessionId } = await seedSession({ live: false, status: 'active' });

    await page.route(`**/sessions/${sessionId}?*`, async (route) => {
      await route.abort('connectionfailed');
    });

    await page.goto(`${baseUrl}#/sessions/${sessionId}`);
    await expect(page.locator('.error-state')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#retry-detail-btn')).toBeVisible();

    // Unblock and click Retry
    await page.unroute(`**/sessions/${sessionId}?*`);
    await page.locator('#retry-detail-btn').click();
    await expect(page.locator('.detail-meta')).toBeVisible({ timeout: 15_000 });
  });
});
