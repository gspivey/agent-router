/**
 * SSE rendering browser tests.
 * Verifies appended stream.log entries render in ID order, auto-scroll,
 * and session_ended hides controls.
 * Spec: .kiro/specs/browser-test-harness/ · task 7.1
 */
import { test, expect } from './fixtures.js';

test('new stream entries render as log-entry elements', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append entries after page navigates (SSE broker polls every 50ms)
  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: 'hello world' });

  // Wait for the entry to appear in the DOM
  const entry = page.locator('.log-entry').filter({ hasText: 'hello world' });
  await expect(entry).toBeVisible({ timeout: 2000 });
});

test('multiple events render in monotonically increasing ID order', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Append several entries
  for (let i = 1; i <= 5; i++) {
    sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: `msg-${i}` });
  }

  // Wait for all entries to render
  await expect(page.locator('.log-entry').filter({ hasText: 'msg-5' })).toBeVisible({ timeout: 2000 });

  // Verify order: each entry text should contain msg-N in ascending order
  const entries = await page.locator('#log-container .log-entry').allTextContents();
  // Filter to only our test entries (stream.log may have initial entries)
  const testEntries = entries.filter(t => t.includes('msg-'));
  const indices = testEntries.map(t => {
    const match = /msg-(\d+)/.exec(t);
    return match ? parseInt(match[1]!, 10) : 0;
  });
  for (let i = 1; i < indices.length; i++) {
    expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
  }
});

test('session_ended event hides controls and updates SSE status', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Verify controls are visible initially
  await expect(page.locator('.controls')).toBeVisible();

  // Append session_ended entry
  sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'router', type: 'session_ended', reason: 'completed' });

  // Wait for SSE status to update
  await expect(page.locator('#sse-status')).toHaveText('Stream ended', { timeout: 2000 });
  // Controls should be hidden
  await expect(page.locator('.controls')).toBeHidden();
});

test('log container auto-scrolls to bottom on new entries', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Fill the container with enough entries to cause scrolling
  for (let i = 0; i < 30; i++) {
    sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: `line-${i}-${'x'.repeat(100)}` });
  }

  // Wait for last entry to render
  await expect(page.locator('.log-entry').filter({ hasText: 'line-29' })).toBeVisible({ timeout: 3000 });

  // Check auto-scroll: scrollTop should be near scrollHeight - clientHeight
  const isScrolledToBottom = await page.evaluate(`(() => {
    const container = document.getElementById('log-container');
    if (!container) return false;
    return container.scrollTop >= container.scrollHeight - container.clientHeight - 5;
  })()`);
  expect(isScrolledToBottom).toBe(true);
});
