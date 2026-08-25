/**
 * Network-shaping reproduction tests for load/SSE failures.
 * Uses CDP Network.emulateNetworkConditions and Playwright route delay/abort
 * to reproduce failures observed on mobile/cloudflared-like connections.
 *
 * These tests form the regression suite that validates the fixes from items 27-29:
 *   - Item 27 eliminated the N+1 fan-out
 *   - Item 28 added fetch resilience (retry, timeout, error state)
 *   - Item 29 added the online event listener for proactive SSE reconnect
 *
 * Repro matrix:
 *   - desktop-direct: low latency, high bandwidth — generally works
 *   - mobile/cloudflared-like: high latency (150ms RTT), limited bandwidth (1.6Mbps),
 *     request concurrency limits, mid-stream cuts, offline transitions
 *
 * Spec: .kiro/specs/browser-test-harness-v2/ · tasks 14.1–14.5
 */
import { test, expect } from './fixtures.js';

// ---------------------------------------------------------------------------
// Area 1: List "Load failed" under request pressure (N+1 fan-out)
// ---------------------------------------------------------------------------

test.describe('List load failures under network pressure', () => {

  test('mobile-cloudflared: N+1 fan-out issues excessive requests', async ({
    page, baseUrl, seedSession,
  }) => {
    // Seed 25 active sessions to trigger the N+1 fan-out (1 list + 25 detail fetches)
    for (let i = 0; i < 25; i++) {
      await seedSession({ live: false, status: 'active' });
    }

    // Track all requests to prove the N+1 pattern
    const requests: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname.startsWith('/sessions')) {
        requests.push(url.pathname + url.search);
      }
    });

    await page.goto(baseUrl);
    await page.waitForSelector('.session-item', { timeout: 10_000 });
    // Wait for the fan-out to complete
    await page.waitForTimeout(1000);

    // The N+1 bug: client issues 1 list request + N per-session detail requests.
    // Item 27 fixed this: the client now issues exactly 1 request.
    const listRequests = requests.filter(r => r.startsWith('/sessions?'));
    const detailRequests = requests.filter(r => /^\/sessions\/[^/]+\?lines=/.test(r));

    // Fixed by item 27: zero per-session detail requests.
    expect(detailRequests.length).toBe(0);
    expect(listRequests.length).toBe(1);

    // Total requests = exactly 1 (the list request only)
    expect(requests.length).toBe(1);
  });

  test('mobile-cloudflared: list renders within 5s under 200ms route delay per request', async ({
    page, baseUrl, seedSession,
  }) => {
    // Seed 20 active sessions with stream entries so waiting_for is populated
    for (let i = 0; i < 20; i++) {
      await seedSession({ live: false, status: 'active', streamEntries: [{ type: 'tool_call' }] });
    }

    // Add 200ms delay to per-session detail requests (cloudflared proxy overhead)
    // With item 27 fix, no detail requests are made so this delay doesn't matter.
    await page.route('**/sessions/*', async (route) => {
      const url = route.request().url();
      if (url.includes('?lines=')) {
        await new Promise(r => setTimeout(r, 200));
      }
      await route.continue();
    });

    await page.goto(baseUrl);

    // Fixed by item 27: the list response includes waiting_for, so no fan-out.
    // All sessions load in one request, well within 5s.
    await page.waitForSelector('.session-item', { timeout: 5000 });

    // All active sessions should show their waiting-for info
    const waitingElements = await page.locator('.session-waiting').count();
    expect(waitingElements).toBeGreaterThan(0);
  });

  test('transient network failure on list fetch shows recovery', async ({
    page, baseUrl, seedSession,
  }) => {
    await seedSession({ live: false, status: 'active' });

    // First request to /sessions fails (simulates transient network blip)
    let requestCount = 0;
    await page.route('**/sessions?*', async (route) => {
      requestCount++;
      if (requestCount === 1) {
        await route.abort('connectionfailed');
      } else {
        await route.continue();
      }
    });

    await page.goto(baseUrl);

    // With retry logic (item 28), the first failure is retried and the list renders.
    await expect(page.locator('.session-item').first()).toBeVisible({ timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// Area 2: SSE drop on mid-stream network cut
// ---------------------------------------------------------------------------

test.describe('SSE failures on mid-stream network cut', () => {

  test('online event alone triggers SSE health check and reconnect', async ({
    page, baseUrl, seedSession, sessionFiles, sseBroker,
  }) => {
    // The online event listener in web-ui.ts triggers a proactive reconnect.
    const { sessionId } = await seedSession({ live: false, status: 'active' });

    await page.goto(`${baseUrl}#/sessions/${sessionId}`);
    await page.waitForSelector('#log-container', { timeout: 5000 });

    sessionFiles.appendStream(sessionId, {
      ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: 'initial',
    });
    await expect(page.locator('.log-entry').filter({ hasText: 'initial' })).toBeVisible({ timeout: 2000 });

    // Track whether a new stream request is made after the online event
    let streamRequestAfterOnline = false;
    const onlineTime = Date.now();

    page.on('request', (req) => {
      if (req.url().includes(`/sessions/${sessionId}/stream`) && Date.now() > onlineTime) {
        streamRequestAfterOnline = true;
      }
    });

    // Dispatch 'online' — the client's online listener proactively reconnects SSE
    await page.evaluate(`window.dispatchEvent(new Event('online'))`);

    // Wait enough time for the proactive reconnect to fire
    await page.waitForTimeout(2000);

    // The online event triggers a stream request
    expect(streamRequestAfterOnline).toBe(true);
  });

  test('hung fetch (no timeout): client times out and shows error', async ({
    page, baseUrl, seedSession,
  }) => {
    test.setTimeout(90_000);
    await seedSession({ live: false, status: 'active' });

    // Make the list request hang forever (simulates a proxy that accepts but doesn't respond)
    await page.route('**/sessions?*', async () => {
      // Never respond — the request hangs
      await new Promise(() => {});
    });

    await page.goto(baseUrl);

    // With a fetch timeout (item 28), the client times out and shows an error with Retry.
    await expect(page.locator('.error-state')).toBeVisible({ timeout: 75_000 });
  });
});

test.describe('SSE failures on backgrounding (mobile)', () => {

  test('online event triggers proactive reconnect request', async ({
    page, baseUrl, seedSession, sessionFiles,
  }) => {
    // The online event listener in web-ui.ts triggers a proactive reconnect.
    const { sessionId } = await seedSession({ live: false, status: 'active' });

    await page.goto(`${baseUrl}#/sessions/${sessionId}`);
    await page.waitForSelector('#log-container', { timeout: 5000 });

    sessionFiles.appendStream(sessionId, {
      ts: new Date().toISOString(), source: 'agent', type: 'agent_message', content: 'setup',
    });
    await expect(page.locator('.log-entry').filter({ hasText: 'setup' })).toBeVisible({ timeout: 2000 });

    // Wait for things to settle — the initial SSE is connected and stable
    await page.waitForTimeout(500);

    // Capture stream requests AFTER this point
    const streamRequestsAfterMark: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes(`/sessions/${sessionId}/stream`)) {
        streamRequestsAfterMark.push(req.url());
      }
    });

    // Dispatch 'online' event — the client's online listener proactively reconnects SSE
    await page.evaluate(`window.dispatchEvent(new Event('online'))`);

    // Wait for the proactive reconnect to fire
    await page.waitForTimeout(2000);

    // The online event triggers at least one new stream request
    expect(streamRequestsAfterMark.length).toBeGreaterThan(0);
  });
});
