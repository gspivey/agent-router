/**
 * Chat-render browser tests (session-stream-chat, item 65 · tasks 5, 6, 7).
 *
 * Verifies the chat-style renderer wired into loadDetailView + the SSE path:
 * - agent messages render markdown in .chat-msg-agent with no visible JSON/HTML artifacts
 * - a tool_call (+ tool_call_update) renders a collapsible .chat-tool card,
 *   collapsed by default on a completed session and toggled by a header click
 * - a _kiro.dev/metadata entry is hidden until "Show internals" is toggled,
 *   then shows a .chat-meta-pill
 * - a session/request_permission entry renders a .chat-permission card
 * - #jump-to-bottom appears after scrolling up on a live session and returns
 *   to the bottom on click
 *
 * Spec: .kiro/specs/session-stream-chat/ · tasks 5, 6, 7 (verified via task 8 criteria)
 */
import { test, expect } from './fixtures.js';

test('agent message renders markdown in .chat-msg-agent with no visible JSON', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({
    live: false,
    status: 'completed',
    streamEntries: [
      { source: 'agent', type: 'agent_message', content: 'Hello **bold** and `code`' },
    ],
  });
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  const bubble = page.locator('.chat-msg-agent').filter({ hasText: 'Hello' });
  await expect(bubble).toBeVisible({ timeout: 5000 });

  // Markdown is rendered to real elements, not shown as literal syntax/JSON.
  await expect(bubble.locator('strong')).toHaveText('bold');
  await expect(bubble.locator('code')).toHaveText('code');
  const text = (await bubble.textContent()) ?? '';
  expect(text).not.toContain('"text":');
  expect(text).not.toContain('agent_message');
  expect(text).not.toContain('**bold**');
});

test('tool_call renders a collapsible .chat-tool card, collapsed on completed session, toggled by header click', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({
    live: false,
    status: 'completed',
    streamEntries: [
      { source: 'agent', type: 'session/update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run tests' } },
      { source: 'agent', type: 'session/update', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ content: { text: 'line-a\nline-b' } }] } },
    ],
  });
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  const card = page.locator('.chat-tool').filter({ hasText: 'Run tests' });
  await expect(card).toBeVisible({ timeout: 5000 });
  // Collapsed by default on a terminal session.
  await expect(card).toHaveClass(/collapsed/);
  // Body hidden while collapsed.
  await expect(card.locator('.chat-tool-body')).toBeHidden();

  // Header click expands.
  await card.locator('.chat-tool-header').click();
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(card.locator('.chat-tool-body')).toBeVisible();
  await expect(card.locator('.chat-tool-body')).toContainText('line-a');

  // Header click collapses again.
  await card.locator('.chat-tool-header').click();
  await expect(card).toHaveClass(/collapsed/);
});

test('_kiro.dev/metadata entry is hidden until "Show internals" is toggled, then shows a .chat-meta-pill', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({
    live: false,
    status: 'completed',
    streamEntries: [
      { source: 'agent', type: '_kiro.dev/metadata', context_usage_percent: 42, turn_duration_ms: 1300 },
    ],
  });
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  const pill = page.locator('.chat-meta-pill');
  // Present in the DOM but hidden until the toggle is checked.
  await expect(pill).toHaveCount(1);
  await expect(pill).toBeHidden();

  await page.locator('#toggle-internals').check();
  await expect(pill).toBeVisible();
  await expect(pill).toContainText('Context 42%');
  await expect(pill).toContainText('1.3s');
});

test('session/request_permission renders a .chat-permission card on an active session', async ({ page, baseUrl, seedSession }) => {
  const { sessionId } = await seedSession({
    live: false,
    status: 'active',
    streamEntries: [
      { source: 'agent', type: 'session/request_permission', toolCall: { title: 'Delete file' }, options: [{ optionId: 'allow' }] },
    ],
  });
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  const perm = page.locator('.chat-permission');
  await expect(perm).toBeVisible({ timeout: 5000 });
  await expect(perm).toContainText('Waiting for approval: Delete file');
  // Not muted while the session is active.
  await expect(perm).not.toHaveClass(/resolved/);
});

test('#jump-to-bottom appears after scrolling up on a live session and returns to bottom on click', async ({ page, baseUrl, seedSession, sessionFiles }) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });
  await page.goto(`${baseUrl}#/sessions/${sessionId}`);
  await page.waitForSelector('#log-container', { timeout: 5000 });

  // Fill the container beyond one viewport so it becomes scrollable.
  for (let i = 0; i < 40; i++) {
    sessionFiles.appendStream(sessionId, { ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: `fill-${i}-${'x'.repeat(80)}` });
  }
  await expect(page.locator('.chat-msg-agent').filter({ hasText: 'fill-39' })).toBeVisible({ timeout: 3000 });

  // Scroll up: the jump button appears.
  await page.evaluate(`(() => { const c = document.getElementById('log-container'); c.scrollTop = 0; c.dispatchEvent(new Event('scroll')); })()`);
  const jump = page.locator('#jump-to-bottom');
  await expect(jump).toBeVisible({ timeout: 2000 });

  // Click jump → scrolls to bottom and hides the button.
  await jump.click();
  await expect(jump).toBeHidden({ timeout: 2000 });
  const atBottom = await page.evaluate(`(() => {
    const c = document.getElementById('log-container');
    return c.scrollTop >= c.scrollHeight - c.clientHeight - 5;
  })()`);
  expect(atBottom).toBe(true);
});
