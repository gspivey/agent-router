/**
 * SPA live SSE streaming — end-to-end against a real Hono server
 * (spa-overhaul Task 6 / ROADMAP 76; Req 6.11; the SSE browser tests moved here
 * from Task 3 per HIGH-7).
 *
 * Drives the built SPA under `/app` against the shared Hono fixture and asserts
 * the full live-streaming stack (Req 4.1, 4.3, 4.4, 7.1, 7.4, 7.6, 7.7, 7.8):
 *
 *   - the SSE client connects with the correct first `Last-Event-ID` derived
 *     from the history `last_event_id` and receives a `log` frame;
 *   - an agent action appends new bubbles WITHOUT a reload;
 *   - dropping the stream shows the reconnect pill, then reconnects sending the
 *     highest-id `Last-Event-ID`, and entries resume with NO duplicate ids;
 *   - the Composer sends an inject;
 *   - the Interrupt confirmation ("Interrupt the current agent turn?") works by
 *     tap and re-fetches `meta` afterward;
 *   - `session_ended` disables (keeps visible) the controls;
 *   - screenshots at 375 px and 1280 px (NFR-4.1).
 *
 * The SSE stream and the inject/interrupt endpoints are driven through Playwright
 * `page.route` interception so frame timing, drops, and reconnects are
 * deterministic — the history load, auth, routing, and shell are the REAL server.
 * Requires `client/dist/`; CI runs `npm run build:client` first.
 */
import { test, expect } from '../fixtures.js';
import type { Route } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** Build one SSE `log` frame carrying a stream entry at the given id. */
function logFrame(id: number, entry: Record<string, unknown>): string {
  return `event: log\nid: ${id}\ndata: ${JSON.stringify(entry)}\n\n`;
}

/** An agent_message_chunk stream entry. */
function chunk(text: string): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    source: 'agent',
    type: 'session/update',
    update: { sessionUpdate: 'agent_message_chunk', content: { text } },
  };
}

/** The seeded history: one chunk so the chat view has a known starting slice. */
const HISTORY: Array<Record<string, unknown>> = [chunk('History line. ')];

test.describe('SPA live SSE streaming', () => {
  test('connects with the history Last-Event-ID and appends a live bubble (Req 4.3, 7.1)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'active',
      repo: 'org/live',
      streamEntries: HISTORY,
    });

    let seenLastEventId: string | null | undefined;
    await page.route(`${baseUrl}/sessions/${sessionId}/stream*`, async (route: Route) => {
      seenLastEventId = route.request().headers()['last-event-id'] ?? null;
      // History has exactly one valid entry → first_event_id = last_event_id = 1,
      // so the first connect must send Last-Event-ID: 1 and the broker replays
      // from id 2. Serve one live chunk at id 2.
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: `:ok\n\n${logFrame(2, chunk('Live append.'))}`,
      });
    });

    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
    await expect(page.getByTestId('chat-view')).toBeVisible();

    // The live chunk appends WITHOUT a reload: the reassembled bubble shows both
    // the history text and the streamed text.
    await expect(page.getByTestId('message-bubble')).toContainText('Live append.');
    // First connect sent the history last_event_id (1).
    expect(seenLastEventId).toBe('1');
  });

  test('reconnect shows the pill, resumes with highest-id, and does not duplicate (Req 4.4, 7.4)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'active',
      repo: 'org/reconnect',
      streamEntries: HISTORY,
    });

    const lastEventIds: Array<string | null> = [];
    let connectCount = 0;
    await page.route(`${baseUrl}/sessions/${sessionId}/stream*`, async (route: Route) => {
      lastEventIds.push(route.request().headers()['last-event-id'] ?? null);
      connectCount += 1;
      if (connectCount === 1) {
        // First connect: deliver id 2 then end the stream (no session_ended) to
        // force a reconnect.
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
          body: `:ok\n\n${logFrame(2, chunk('first. '))}`,
        });
      } else {
        // Reconnect: replay id 2 (duplicate, must be deduped) + a new id 3.
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
          body: `:ok\n\n${logFrame(2, chunk('first. '))}${logFrame(3, chunk('second.'))}`,
        });
      }
    });

    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
    await expect(page.getByTestId('chat-view')).toBeVisible();

    // Eventually both live chunks render; the reconnect pill appears during the
    // backoff gap (first retry is 1000 ms per computeBackoff).
    await expect(page.getByTestId('reconnect-pill')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('message-bubble')).toContainText('second.', { timeout: 10000 });

    // No duplicate: the id-2 text appears exactly once despite being replayed.
    const bubbleText = (await page.getByTestId('message-bubble').textContent()) ?? '';
    const occurrences = bubbleText.split('first.').length - 1;
    expect(occurrences).toBe(1);

    // The reconnect sent the highest id seen so far (2), not the history value.
    expect(lastEventIds[0]).toBe('1');
    expect(lastEventIds[1]).toBe('2');
  });

  test('the Composer sends an inject (Req 7.6)', async ({ page, baseUrl, token, seedSession }) => {
    const { sessionId } = await seedSession({
      status: 'active',
      repo: 'org/inject',
      streamEntries: HISTORY,
    });

    // Keep the stream open and quiet so the chat view stays live.
    await page.route(`${baseUrl}/sessions/${sessionId}/stream*`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: ':ok\n\n',
      });
    });

    let injectBody: string | null = null;
    await page.route(`${baseUrl}/sessions/${sessionId}/inject`, async (route: Route) => {
      injectBody = route.request().postData();
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ accepted: true }),
      });
    });

    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
    await expect(page.getByTestId('composer')).toBeVisible();

    await page.getByTestId('composer-input').fill('please investigate CI');
    await page.getByTestId('composer-send').click();

    await expect.poll(() => injectBody).not.toBeNull();
    expect(injectBody).toContain('please investigate CI');
    // Input cleared on success.
    await expect(page.getByTestId('composer-input')).toHaveValue('');
  });

  test('Interrupt confirmation works by tap and re-fetches meta (Req 7.7)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'active',
      repo: 'org/interrupt',
      streamEntries: HISTORY,
    });

    await page.route(`${baseUrl}/sessions/${sessionId}/stream*`, async (route: Route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: ':ok\n\n',
      });
    });

    let interruptCalled = false;
    await page.route(`${baseUrl}/sessions/${sessionId}/interrupt`, async (route: Route) => {
      interruptCalled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    // Count the meta re-fetches (GET /sessions/:id?...).
    let metaGets = 0;
    page.on('request', (req) => {
      if (req.method() === 'GET' && /\/sessions\/[^/]+\?/.test(req.url())) metaGets += 1;
    });

    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
    await expect(page.getByTestId('interrupt-button')).toBeVisible();

    await page.getByTestId('interrupt-button').click();
    // The exact confirmation copy, confirmable by tap (no hover).
    await expect(page.getByTestId('interrupt-confirm')).toContainText(
      'Interrupt the current agent turn?',
    );
    await page.getByTestId('interrupt-confirm-button').click();

    await expect.poll(() => interruptCalled).toBe(true);
    // A meta re-fetch follows the interrupt (initial history GET + the re-fetch).
    await expect.poll(() => metaGets).toBeGreaterThanOrEqual(2);
  });

  test('session_ended disables (keeps visible) the controls (Req 7.8)', async ({
    page,
    baseUrl,
    token,
    seedSession,
  }) => {
    const { sessionId } = await seedSession({
      status: 'active',
      repo: 'org/ended',
      streamEntries: HISTORY,
    });

    await page.route(`${baseUrl}/sessions/${sessionId}/stream*`, async (route: Route) => {
      // Deliver one chunk, then a session_ended frame.
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: `:ok\n\n${logFrame(2, chunk('final.'))}event: session_ended\nid: 3\ndata: {}\n\n`,
      });
    });

    await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
    await expect(page.getByTestId('chat-view')).toBeVisible();

    // Controls become inert but remain visible.
    await expect(page.getByTestId('composer-input')).toBeDisabled();
    await expect(page.getByTestId('interrupt-button')).toBeDisabled();
    await expect(page.getByTestId('composer')).toBeVisible();
    await expect(page.getByTestId('interrupt-button')).toBeVisible();
    // The ended system pill is appended.
    await expect(page.getByTestId('chat-log')).toContainText('Session ended');
    // No streaming cursor after the session ends.
    const logText = (await page.getByTestId('chat-log').textContent()) ?? '';
    expect(logText).not.toContain('▌');
  });

  for (const vp of VIEWPORTS) {
    test(`live chat renders at ${vp.name} (${vp.width}px) with screenshot (NFR-4.1)`, async ({
      page,
      baseUrl,
      token,
      seedSession,
    }) => {
      const { sessionId } = await seedSession({
        status: 'active',
        repo: 'org/shot',
        streamEntries: HISTORY,
      });

      await page.route(`${baseUrl}/sessions/${sessionId}/stream*`, async (route: Route) => {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
          body: `:ok\n\n${logFrame(2, chunk('streamed line.'))}`,
        });
      });

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`${baseUrl}/app?token=${token}#/sessions/${sessionId}`);
      await expect(page.getByTestId('message-bubble')).toContainText('streamed line.');

      // The always-visible Composer is present on every viewport (Req 7.6).
      await expect(page.getByTestId('composer')).toBeVisible();

      await page.screenshot({ path: `test-results/spa-sse-live-${vp.name}.png`, fullPage: true });
    });
  }
});
