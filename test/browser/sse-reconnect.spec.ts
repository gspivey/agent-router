/**
 * SSE reconnection browser tests.
 * Verifies drop via disconnectAll triggers reconnect with Last-Event-ID,
 * no duplicate IDs, no reconnect after session_ended, and delay reset.
 * Spec: .kiro/specs/browser-test-harness-v2/ · tasks 7.1, 7.2, 7.3, 7.4, 7.5
 */
import { test, expect } from './fixtures.js';

test('stream drop shows reconnecting status', async ({ page, baseUrl, seedSession, sessionFiles, sseBroker }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append entries after navigation so SSE delivers them (avoids initial-load duplication)
  for (let i = 0; i < 3; i++) {
    sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: `entry-${i}` });
  }
  await expect(page.locator('.log-entry').filter({ hasText: 'entry-2' })).toBeVisible({ timeout: 2000 });

  // Drop the connection
  sseBroker.disconnectAll(sessionId);

  // Status should show reconnecting
  await expect(page.locator('#sse-status')).toHaveText('Reconnecting in 1s...', { timeout: 2000 });
});

test('no duplicate event IDs after reconnect', async ({ page, baseUrl, seedSession, sessionFiles, sseBroker }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append entries after navigation
  for (let i = 1; i <= 5; i++) {
    sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: `msg-${i}` });
  }
  await expect(page.locator('.log-entry').filter({ hasText: 'msg-5' })).toBeVisible({ timeout: 2000 });

  // Drop and wait for reconnect
  sseBroker.disconnectAll(sessionId);
  await expect(page.locator('#sse-status')).toHaveText('Connected', { timeout: 5000 });

  // Check no duplicates: each msg-N should appear exactly once
  const entries = await page.locator('#log-container .log-entry').allTextContents();
  const msgEntries = entries.filter(t => /msg-\d+/.test(t));
  const ids = msgEntries.map(t => {
    const m = /msg-(\d+)/.exec(t);
    return m ? m[1] : '';
  });
  const uniqueIds = new Set(ids);
  expect(uniqueIds.size).toBe(ids.length);
});

test('reconnection request includes Last-Event-ID header', async ({ page, baseUrl, seedSession, sessionFiles, sseBroker }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append entries after navigation so lastId advances
  for (let i = 1; i <= 3; i++) {
    sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: `data-${i}` });
  }
  await expect(page.locator('.log-entry').filter({ hasText: 'data-3' })).toBeVisible({ timeout: 2000 });

  // Capture reconnect request
  const reconnectPromise = page.waitForRequest((req) =>
    req.url().includes(`/sessions/${sessionId}/stream`) && req.headers()['last-event-id'] !== undefined
  );

  sseBroker.disconnectAll(sessionId);

  const reconnectReq = await reconnectPromise;
  const lastEventId = reconnectReq.headers()['last-event-id'];
  expect(lastEventId).toBe('3');
});

test('no reconnection after session_ended event', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append an entry and then session_ended
  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: 'hello' });
  await expect(page.locator('.log-entry').filter({ hasText: 'hello' })).toBeVisible({ timeout: 2000 });

  // Emit session_ended
  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'router', type: 'session_ended', reason: 'completed' });
  await expect(page.locator('#sse-status')).toHaveText('Stream ended', { timeout: 2000 });

  // Track any new stream requests — there should be none
  let reconnectAttempted = false;
  page.on('request', (req) => {
    if (req.url().includes(`/sessions/${sessionId}/stream`)) {
      reconnectAttempted = true;
    }
  });

  // Wait sufficient time for a reconnect to have happened (2s > backoff initial 1s)
  await page.waitForTimeout(2000);
  expect(reconnectAttempted).toBe(false);
});

test('delay resets after successful reconnect', async ({ page, baseUrl, seedSession, sessionFiles, sseBroker }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });

  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append an entry after navigation
  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: 'init-data' });
  await expect(page.locator('.log-entry').filter({ hasText: 'init-data' })).toBeVisible({ timeout: 2000 });

  // First drop — reconnect within ~1s
  const t1Start = Date.now();
  const reconnect1 = page.waitForRequest((req) =>
    req.url().includes(`/sessions/${sessionId}/stream`) && req.headers()['last-event-id'] !== undefined
  );
  sseBroker.disconnectAll(sessionId);
  await reconnect1;
  const t1Elapsed = Date.now() - t1Start;
  // First reconnect should be within 1500ms (1s backoff + 500ms tolerance)
  expect(t1Elapsed).toBeLessThan(1500);

  // Wait for reconnect to succeed (status shows Connected)
  await expect(page.locator('#sse-status')).toHaveText('Connected', { timeout: 3000 });

  // Second drop — should also reconnect within ~1s (delay was reset)
  const t2Start = Date.now();
  const reconnect2 = page.waitForRequest((req) =>
    req.url().includes(`/sessions/${sessionId}/stream`) &&
    req.headers()['last-event-id'] !== undefined &&
    Date.now() > t2Start // ensure it's a new request
  );
  sseBroker.disconnectAll(sessionId);
  await reconnect2;
  const t2Elapsed = Date.now() - t2Start;
  // Second reconnect should also be within 1500ms (confirming delay reset)
  expect(t2Elapsed).toBeLessThan(1500);
});
