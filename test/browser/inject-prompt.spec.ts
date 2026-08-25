/**
 * Prompt injection browser tests.
 * Verifies seedSession({live:true}) with slow-multi-prompt.json scenario,
 * inject yields a web_inject stream entry and clears the textarea.
 * Spec: .kiro/specs/browser-test-harness-v2/ · tasks 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */
import { test, expect } from './fixtures.js';

test('inject sends prompt and clears textarea on success', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: true });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#prompt-input', { timeout: 5000 });

  // Fill textarea and click Send
  await page.fill('#prompt-input', 'test prompt message');
  await page.click('#btn-send');

  // Textarea should be cleared after success
  await expect(page.locator('#prompt-input')).toHaveValue('', { timeout: 3000 });
  // Send button should be re-enabled
  await expect(page.locator('#btn-send')).toBeEnabled({ timeout: 2000 });
});

test('inject creates web_inject entry in stream.log', async ({ page, baseUrl, seedSession, rootDir }) => {
  const { sessionId } = await seedSession({ live: true });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#prompt-input', { timeout: 5000 });

  await page.fill('#prompt-input', 'hello agent');
  await page.click('#btn-send');

  // Wait for textarea to clear (indicating success)
  await expect(page.locator('#prompt-input')).toHaveValue('', { timeout: 3000 });

  // Verify stream.log contains web_inject entry
  await page.waitForTimeout(200); // Small delay for appendStream to flush
  const fs = await import('node:fs');
  const streamPath = `${rootDir}/sessions/${sessionId}/stream.log`;
  const content = fs.readFileSync(streamPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const entries = lines.map((l: string) => JSON.parse(l));
  const injectEntry = entries.find((e: Record<string, unknown>) => e.type === 'web_inject');
  expect(injectEntry).toBeDefined();
  expect(injectEntry.source).toBe('router');
  expect(injectEntry.type).toBe('web_inject');
});

test('empty textarea does not send request', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({ live: true });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#prompt-input', { timeout: 5000 });

  // Track requests to inject endpoint
  let injectRequested = false;
  page.on('request', (req) => {
    if (req.url().includes('/inject') && req.method() === 'POST') {
      injectRequested = true;
    }
  });

  // Clear the textarea (ensure empty) and click Send
  await page.fill('#prompt-input', '');
  await page.click('#btn-send');

  // Wait briefly and confirm no request was made
  await page.waitForTimeout(500);
  expect(injectRequested).toBe(false);
  // Button should remain enabled
  await expect(page.locator('#btn-send')).toBeEnabled();
});

test('whitespace-only textarea does not send request', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({ live: true });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#prompt-input', { timeout: 5000 });

  let injectRequested = false;
  page.on('request', (req) => {
    if (req.url().includes('/inject') && req.method() === 'POST') {
      injectRequested = true;
    }
  });

  await page.fill('#prompt-input', '   \n  ');
  await page.click('#btn-send');

  await page.waitForTimeout(500);
  expect(injectRequested).toBe(false);
  await expect(page.locator('#btn-send')).toBeEnabled();
});

test('inject failure shows alert and does not clear textarea', async ({ page, baseUrl, seedSession, console: collector }) => {
  const { sessionId } = await seedSession({ live: true });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#prompt-input', { timeout: 5000 });

  // Intercept the inject request to simulate a server error
  await page.route(`**/sessions/${sessionId}/inject`, (route) => {
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal_error', message: 'Something went wrong' } }),
    });
  });

  // Fill and send — should get error response
  await page.fill('#prompt-input', 'will fail');
  await page.click('#btn-send');

  // Alert should be captured by ConsoleCollector
  await page.waitForTimeout(1000);
  expect(collector.dialogs.length).toBeGreaterThan(0);
  expect(collector.dialogs[0]).toContain('Inject failed');
  // Textarea should NOT be cleared
  await expect(page.locator('#prompt-input')).toHaveValue('will fail');
});

test('non-active session does not render controls', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({ live: false, status: 'completed' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#detail-view', { timeout: 5000 });

  // Controls (textarea, send) should not be present
  await expect(page.locator('#prompt-input')).toHaveCount(0);
  await expect(page.locator('#btn-send')).toHaveCount(0);
});
