/**
 * SSE hardening browser tests.
 * Verifies: online event triggers reconnect, de-dupe by event id,
 * no reconnect after session_ended.
 * Spec: .kiro/specs/web-client/ · task 4.2
 */
import { test, expect } from './fixtures.js';

test('online event triggers SSE reconnect', async ({ page, baseUrl, seedSession, sessionFiles, sseBroker }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append entries so lastId advances
  for (let i = 1; i <= 3; i++) {
    sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: `online-${i}` });
  }
  await expect(page.locator('.log-entry').filter({ hasText: 'online-3' })).toBeVisible({ timeout: 2000 });

  // Capture the reconnect request that should carry Last-Event-ID
  const reconnectPromise = page.waitForRequest((req) =>
    req.url().includes(`/sessions/${sessionId}/stream`) && req.headers()['last-event-id'] !== undefined
  );

  // Simulate going offline then online via page script (dispatchEvent)
  await page.evaluate(`window.dispatchEvent(new Event('online'))`);

  const reconnectReq = await reconnectPromise;
  const lastEventId = reconnectReq.headers()['last-event-id'];
  expect(lastEventId).toBe('3');

  // After reconnect, new entries should still arrive
  await expect(page.locator('#sse-status')).toHaveText('Connected', { timeout: 5000 });
  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: 'after-online' });
  await expect(page.locator('.log-entry').filter({ hasText: 'after-online' })).toBeVisible({ timeout: 2000 });
});

test('no duplicate entries after online reconnect', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append entries
  for (let i = 1; i <= 5; i++) {
    sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: `dedup-${i}` });
  }
  await expect(page.locator('.log-entry').filter({ hasText: 'dedup-5' })).toBeVisible({ timeout: 2000 });

  // Trigger online reconnect
  await page.evaluate(`window.dispatchEvent(new Event('online'))`);
  await expect(page.locator('#sse-status')).toHaveText('Connected', { timeout: 5000 });

  // Verify no duplicates
  const entries = await page.locator('#log-container .log-entry').allTextContents();
  const dedupEntries = entries.filter(t => /dedup-\d+/.test(t));
  const ids = dedupEntries.map(t => {
    const m = /dedup-(\d+)/.exec(t);
    return m ? m[1] : '';
  });
  const uniqueIds = new Set(ids);
  expect(uniqueIds.size).toBe(ids.length);
  expect(uniqueIds.size).toBe(5);
});

test('no reconnect after session_ended on online event', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append entry then session_ended
  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: 'final-msg' });
  await expect(page.locator('.log-entry').filter({ hasText: 'final-msg' })).toBeVisible({ timeout: 2000 });

  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'router', type: 'session_ended', reason: 'completed' });
  await expect(page.locator('#sse-status')).toHaveText('Stream ended', { timeout: 2000 });

  // Track any new stream requests
  let reconnectAttempted = false;
  page.on('request', (req) => {
    if (req.url().includes(`/sessions/${sessionId}/stream`)) {
      reconnectAttempted = true;
    }
  });

  // Fire online event — should NOT trigger reconnect since session ended
  await page.evaluate(`window.dispatchEvent(new Event('online'))`);

  // Wait sufficient time for any reconnect attempt
  await page.waitForTimeout(2000);
  expect(reconnectAttempted).toBe(false);
});

test('no reconnect after session_ended on visibilitychange', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append entry then session_ended
  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: 'last-one' });
  await expect(page.locator('.log-entry').filter({ hasText: 'last-one' })).toBeVisible({ timeout: 2000 });

  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'router', type: 'session_ended', reason: 'completed' });
  await expect(page.locator('#sse-status')).toHaveText('Stream ended', { timeout: 2000 });

  // Track any new stream requests
  let reconnectAttempted = false;
  page.on('request', (req) => {
    if (req.url().includes(`/sessions/${sessionId}/stream`)) {
      reconnectAttempted = true;
    }
  });

  // Trigger visibility change via CDP
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });

  // Wait sufficient time
  await page.waitForTimeout(2000);
  expect(reconnectAttempted).toBe(false);
});
