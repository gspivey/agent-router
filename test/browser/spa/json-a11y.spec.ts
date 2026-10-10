/**
 * SPA JSON pivot + accessibility (spa-overhaul Task 7 / ROADMAP 77).
 *
 * Drives the built SPA under `/app` against a real Hono daemon (shared fixture)
 * and asserts the Requirement 8 behaviors on a historical (completed) session:
 *
 *   - the `{ }` JSON-toggle chip flips a bubble to a raw-JSON `<pre>` and back,
 *     and is always visible at 375 px (Req 8.1, 8.2);
 *   - the conversation container carries `role="log"` and `aria-live="polite"`
 *     and each entry is focusable (Req 8.4);
 *   - a tap-target bounding-box audit confirms every interactive element is at
 *     least 44×44 CSS px (Req 8.6);
 *   - screenshots of the JSON view at 375 px and 1280 px (NFR-4.1).
 *
 * Requires `client/dist/` to exist; CI runs `npm run build:client` first.
 */
import { test, expect } from '../fixtures.js';

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** A short history covering a bubble, a tool card, and a system pill. */
const HISTORY: Array<Record<string, unknown>> = [
  { source: 'router', type: 'session_started' },
  {
    source: 'agent',
    type: 'session/update',
    update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hello operator' } },
  },
  {
    source: 'agent',
    type: 'session/update',
    update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'read_file src/index.ts' },
  },
];

test.describe('SPA JSON pivot + accessibility', () => {
  test('JSON toggle flips a bubble to <pre> and back (Req 8.1, 8.2)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'completed',
      repo: 'org/json',
      streamEntries: HISTORY,
    });

    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
    await expect(page.getByTestId('message-bubble')).toHaveCount(1);

    // Entry order mirrors HISTORY: [system pill, agent bubble, tool card].
    // The bubble's entry shell is the 2nd chat-entry; reference it positionally
    // so the locator stays stable after the content swaps to <pre>.
    const bubbleEntry = page.getByTestId('chat-entry').nth(1);
    await expect(bubbleEntry.getByTestId('message-bubble')).toHaveCount(1);
    const toggle = bubbleEntry.getByTestId('json-toggle');
    await expect(toggle).toBeVisible();

    // Rendered view first; no <pre> yet.
    await expect(bubbleEntry.getByTestId('entry-json')).toHaveCount(0);

    // Activate → raw-JSON <pre> containing the entry's data.
    await toggle.click();
    const pre = bubbleEntry.getByTestId('entry-json');
    await expect(pre).toBeVisible();
    await expect(pre).toContainText('session/update');
    await expect(bubbleEntry.getByTestId('message-bubble')).toHaveCount(0);

    // Activate again → back to the rendered bubble.
    await toggle.click();
    await expect(bubbleEntry.getByTestId('message-bubble')).toBeVisible();
    await expect(bubbleEntry.getByTestId('entry-json')).toHaveCount(0);
  });

  test('the JSON toggle is always visible at 375px (Req 8.1)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'completed',
      repo: 'org/json-mobile',
      streamEntries: HISTORY,
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
    await expect(page.getByTestId('message-bubble')).toHaveCount(1);

    // Every entry exposes an always-visible toggle (no hover required).
    const toggles = page.getByTestId('json-toggle');
    const count = await toggles.count();
    expect(count).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < count; i++) {
      await expect(toggles.nth(i)).toBeVisible();
    }
  });

  test('conversation container has role=log + aria-live and entries are focusable (Req 8.4)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'completed',
      repo: 'org/a11y',
      streamEntries: HISTORY,
    });

    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);

    const log = page.getByTestId('chat-log');
    await expect(log).toHaveAttribute('role', 'log');
    await expect(log).toHaveAttribute('aria-live', 'polite');

    // Entries are focusable (tabindex=0) and can actually receive focus.
    const firstEntry = page.getByTestId('chat-entry').first();
    await expect(firstEntry).toHaveAttribute('tabindex', '0');
    await firstEntry.focus();
    await expect(firstEntry).toBeFocused();
  });

  test('desktop ? opens the help overlay and Escape closes it (Req 8.5)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'completed',
      repo: 'org/help',
      streamEntries: HISTORY,
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
    await expect(page.getByTestId('message-bubble')).toHaveCount(1);

    await expect(page.getByTestId('help-overlay')).toHaveCount(0);
    await page.keyboard.press('?');
    await expect(page.getByTestId('help-overlay')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('help-overlay')).toHaveCount(0);
  });

  test('desktop J toggles JSON on the focused entry (Req 8.5)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'completed',
      repo: 'org/jkey',
      streamEntries: HISTORY,
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);

    const bubbleEntry = page.getByTestId('chat-entry').nth(1);
    await expect(bubbleEntry.getByTestId('message-bubble')).toHaveCount(1);
    await bubbleEntry.focus();
    await page.keyboard.press('j');
    await expect(bubbleEntry.getByTestId('entry-json')).toBeVisible();
    await page.keyboard.press('j');
    await expect(bubbleEntry.getByTestId('entry-json')).toHaveCount(0);
  });

  test('every interactive element presents a ≥44×44 tap target (Req 8.6)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'completed',
      repo: 'org/taps',
      streamEntries: HISTORY,
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
    await expect(page.getByTestId('message-bubble')).toHaveCount(1);

    // Audit every visible, enabled interactive control's bounding box.
    const controls = page.locator('button, a[href], input, [role="button"]');
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const el = controls.nth(i);
      if (!(await el.isVisible())) continue;
      const box = await el.boundingBox();
      if (box === null) continue;
      // Allow a 1px rounding tolerance.
      expect(box.width, `control ${i} width`).toBeGreaterThanOrEqual(43.5);
      expect(box.height, `control ${i} height`).toBeGreaterThanOrEqual(43.5);
    }
  });

  for (const vp of VIEWPORTS) {
    test(`JSON view screenshot at ${vp.name} (${vp.width}px) (NFR-4.1)`, async ({
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

      // Flip the bubble to its JSON view, then capture.
      const bubbleEntry = page.getByTestId('chat-entry').nth(1);
      await expect(bubbleEntry.getByTestId('message-bubble')).toHaveCount(1);
      await bubbleEntry.getByTestId('json-toggle').click();
      await expect(bubbleEntry.getByTestId('entry-json')).toBeVisible();

      await page.screenshot({ path: `test-results/spa-json-${vp.name}.png`, fullPage: true });
    });
  }
});
