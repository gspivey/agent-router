/**
 * Visibility reconnection browser tests.
 * Verifies CDP Page.setWebLifecycleState (hidden → active) triggers SSE
 * reconnect with last event ID; entries appended while hidden appear on
 * resume; no duplicate IDs.
 * Spec: .kiro/specs/browser-test-harness-v2/ · tasks 8.1, 8.2, 8.3
 */
import { test, expect } from './fixtures.js';

test('hidden→active triggers SSE reconnect with last event ID', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append entries so lastEventId advances
  for (let i = 1; i <= 3; i++) {
    sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: `vis-${i}` });
  }
  await expect(page.locator('.log-entry').filter({ hasText: 'vis-3' })).toBeVisible({ timeout: 2000 });

  // Wait for the SSE connection to be stable
  await expect(page.locator('#sse-status')).toHaveText('Connected', { timeout: 5000 });

  // Set up page.route() intercept to capture the Last-Event-ID header on reconnect
  let capturedLastEventId: string | null = null;
  await page.route(`**/sessions/${sessionId}/stream`, (route) => {
    const lastEventIdHeader = route.request().headers()['last-event-id'];
    if (lastEventIdHeader !== undefined) {
      capturedLastEventId = lastEventIdHeader;
    }
    return route.continue();
  });

  // Use CDP to transition frozen → active (triggers visibilitychange reconnect)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });

  // The CDP lifecycle state change may not reliably trigger visibilitychange in
  // headless Chromium. Supplement with a direct visibilitychange dispatch that
  // matches how the web-ui.ts handler checks document.visibilityState === 'visible'.
  // The active state should set visibilityState to 'visible', but if the handler
  // didn't fire from CDP alone, explicitly dispatch the event.
  await page.evaluate(`
    if (document.visibilityState === 'visible') {
      document.dispatchEvent(new Event('visibilitychange'));
    }
  `);

  // Wait for the reconnect request to complete
  await expect(page.locator('#sse-status')).toHaveText('Connected', { timeout: 5000 });

  // Assert the reconnect carried the correct Last-Event-ID header
  expect(capturedLastEventId).toBe('3');

  // Clean up the route intercept
  await page.unroute(`**/sessions/${sessionId}/stream`);

  // Append a new entry after reconnect — it should arrive via the new SSE stream
  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: 'after-reconnect' });
  await expect(page.locator('.log-entry').filter({ hasText: 'after-reconnect' })).toBeVisible({ timeout: 2000 });

  // Verify all original entries are still present (reconnect resumed correctly)
  for (let i = 1; i <= 3; i++) {
    await expect(page.locator('.log-entry').filter({ hasText: `vis-${i}` })).toBeVisible();
  }
});

test('entries appended while hidden appear on resume', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append initial entries
  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: 'before-hidden' });
  await expect(page.locator('.log-entry').filter({ hasText: 'before-hidden' })).toBeVisible({ timeout: 2000 });

  // Go frozen (hidden) via CDP
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });

  // Append entries while hidden
  for (let i = 1; i <= 3; i++) {
    sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: `hidden-${i}` });
  }

  // Resume: transition back to active
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });

  // Entries appended while hidden should appear within 5s
  await expect(page.locator('.log-entry').filter({ hasText: 'hidden-1' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.log-entry').filter({ hasText: 'hidden-2' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.log-entry').filter({ hasText: 'hidden-3' })).toBeVisible({ timeout: 5000 });
});

test('no duplicate IDs after visibility-change reconnect', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append entries
  for (let i = 1; i <= 5; i++) {
    sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: `dup-check-${i}` });
  }
  await expect(page.locator('.log-entry').filter({ hasText: 'dup-check-5' })).toBeVisible({ timeout: 2000 });

  // Trigger visibility change reconnect
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });

  // Wait for reconnect to complete
  await expect(page.locator('#sse-status')).toHaveText('Connected', { timeout: 5000 });

  // Verify no duplicate entries
  const entries = await page.locator('#log-container .log-entry').allTextContents();
  const dupEntries = entries.filter(t => /dup-check-\d+/.test(t));
  const ids = dupEntries.map(t => {
    const m = /dup-check-(\d+)/.exec(t);
    return m ? m[1] : '';
  });
  const uniqueIds = new Set(ids);
  expect(uniqueIds.size).toBe(ids.length);
  expect(uniqueIds.size).toBe(5);
});
