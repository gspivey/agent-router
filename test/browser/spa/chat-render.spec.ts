/**
 * SPA chat view — historical bubble renderer, all entry kinds
 * (spa-overhaul Task 5 / ROADMAP 75).
 *
 * Drives the built SPA under `/app` against a real Hono daemon (shared fixture)
 * and asserts the Requirement 6 behaviors on a historical (completed) session:
 *
 *   - every `ParsedEntry` kind renders with its dedicated component (Req 6.1-6.7);
 *   - the permission card is READ-ONLY — no action buttons (Req 6.5);
 *   - at 375 px, message bubbles are constrained to `max-w-[85vw]` and tool
 *     cards render collapsed by default (Req 6.8);
 *   - a completed-session history load shows NO streaming cursor glyph (Req 7.2,
 *     historical only — SSE/streaming states land in Task 6);
 *   - screenshots are captured at 375 px and 1280 px (NFR-4.1).
 *
 * Requires `client/dist/` to exist; CI runs `npm run build:client` first.
 */
import { test, expect } from '../fixtures.js';

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** A history covering every entry kind the chat view renders. */
const HISTORY: Array<Record<string, unknown>> = [
  { source: 'router', type: 'session_started' },
  {
    source: 'agent',
    type: 'session/update',
    update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hello ' } },
  },
  {
    source: 'agent',
    type: 'session/update',
    update: { sessionUpdate: 'agent_message_chunk', content: { text: 'operator' } },
  },
  {
    source: 'agent',
    type: 'session/update',
    update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'read_file src/index.ts' },
  },
  {
    source: 'agent',
    type: 'session/update',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      content: [{ content: { text: 'file body line\n' } }],
    },
  },
  { source: 'agent', type: 'session/request_permission', toolCall: { title: 'run shell: ls -la' } },
  { source: 'agent', type: '_kiro.dev/metadata', content: 'context note' },
  { source: 'agent', type: 'totally_unrecognized_type' },
];

test.describe('SPA chat view — historical render', () => {
  test('renders every entry kind with its component (Req 6.1-6.7)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'completed',
      repo: 'org/chat',
      streamEntries: HISTORY,
    });

    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);

    await expect(page.getByTestId('chat-view')).toBeVisible();
    await expect(page.getByTestId('chat-loading')).toHaveCount(0);

    // Reassembled agent bubble ("Hello operator").
    const bubble = page.getByTestId('message-bubble');
    await expect(bubble).toHaveCount(1);
    await expect(bubble).toContainText('Hello operator');

    // System pill, tool card, permission card, internal pill, unknown pill.
    await expect(page.getByTestId('system-pill')).toContainText('Session started');
    await expect(page.getByTestId('tool-call-header')).toContainText('read_file');
    await expect(page.getByTestId('permission-card')).toContainText('run shell');
    await expect(page.getByTestId('internal-pill')).toHaveCount(1);
    await expect(page.getByTestId('unknown-pill')).toContainText('totally_unrecognized_type');
  });

  test('permission card renders no action buttons (Req 6.5)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'completed',
      repo: 'org/perm',
      streamEntries: [{ source: 'agent', type: 'session/request_permission', toolCall: { title: 'approve' } }],
    });

    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);

    const card = page.getByTestId('permission-card');
    await expect(card).toBeVisible();
    expect(await card.locator('button').count()).toBe(0);
  });

  test('a completed-session load shows no streaming cursor (Req 7.2)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'completed',
      repo: 'org/done',
      streamEntries: HISTORY,
    });

    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
    await expect(page.getByTestId('message-bubble')).toHaveCount(1);

    const logText = (await page.getByTestId('chat-log').textContent()) ?? '';
    expect(logText).not.toContain('▌');
  });

  test('at 375px bubbles are max-w-[85vw] and tool cards start collapsed (Req 6.8)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'completed',
      repo: 'org/mobile',
      streamEntries: HISTORY,
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);

    // Tool card collapsed by default: header present, body hidden.
    const header = page.getByTestId('tool-call-header');
    await expect(header).toBeVisible();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('tool-call-body')).toHaveCount(0);

    // The bubble's rendered width does not exceed 85vw of the 375px viewport.
    const bubbleBox = await page.getByTestId('message-bubble').locator('> div').boundingBox();
    expect(bubbleBox).not.toBeNull();
    if (bubbleBox) expect(bubbleBox.width).toBeLessThanOrEqual(0.85 * 375 + 1);

    // Expanding the card reveals its folded body.
    await header.click();
    await expect(page.getByTestId('tool-call-body')).toContainText('file body line');
  });

  for (const vp of VIEWPORTS) {
    test(`chat renders at ${vp.name} (${vp.width}px) with screenshot (NFR-4.1)`, async ({
      page,
      baseUrl,
      token,
      seedSession,
    }) => {
      const { sessionId } = await seedSession({
        status: 'completed',
        repo: 'org/shot',
        streamEntries: HISTORY,
      });

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
      await expect(page.getByTestId('message-bubble')).toHaveCount(1);

      await page.screenshot({ path: `test-results/spa-chat-${vp.name}.png`, fullPage: true });
    });
  }
});
