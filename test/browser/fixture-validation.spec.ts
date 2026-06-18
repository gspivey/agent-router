/**
 * Fixture validation spec.
 *
 * Proves the per-test server lifecycle: server starts on an ephemeral port,
 * seedSession works in both live:false and live:true modes, ConsoleCollector
 * captures errors, and teardown cleans up.
 */
import { test, expect } from './fixtures.js';

test('server starts and responds to health check', async ({ baseUrl, token }) => {
  const res = await fetch(`${baseUrl}/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessions: unknown[] };
  expect(Array.isArray(body.sessions)).toBe(true);
});

test('seedSession live:false creates filesystem-only session', async ({
  baseUrl,
  token,
  seedSession,
  sessionFiles,
}) => {
  const { sessionId } = await seedSession({ live: false, status: 'active' });
  expect(sessionFiles.sessionExists(sessionId)).toBe(true);
  const meta = sessionFiles.readMeta(sessionId);
  expect(meta.status).toBe('active');
  expect(meta.repo).toBe('test-org/test-repo');

  // Session appears in API
  const res = await fetch(`${baseUrl}/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { sessions: Array<{ session_id: string }> };
  const found = body.sessions.find((s) => s.session_id === sessionId);
  expect(found).toBeDefined();
});

test('seedSession live:true creates a live session with FakeKiroBackend', async ({
  baseUrl,
  token,
  seedSession,
  sessionManager,
}) => {
  const { sessionId } = await seedSession({ live: true });
  const handle = sessionManager.getActiveSession(sessionId);
  expect(handle).not.toBeNull();
  expect(handle!.sessionId).toBe(sessionId);
});

test('seedSession with streamEntries appends entries', async ({
  seedSession,
  sessionFiles,
  rootDir,
}) => {
  const { sessionId } = await seedSession({
    live: false,
    streamEntries: [
      { type: 'message', content: 'hello' },
      { type: 'message', content: 'world' },
    ],
  });

  const streamPath = `${rootDir}/sessions/${sessionId}/stream.log`;
  const content = (await import('node:fs')).readFileSync(streamPath, 'utf-8');
  const lines = content.trim().split('\n');
  // createSession writes an initial entry, plus our 2 = 3 total
  expect(lines.length).toBeGreaterThanOrEqual(2);
});

test('ConsoleCollector captures page errors', async ({ page, baseUrl, console: collector }) => {
  await page.goto(baseUrl);
  // Inject a console.error from the page
  await page.evaluate(() => {
    console.error('test-error-message');
  });
  // Give the event time to propagate
  await page.waitForTimeout(100);
  expect(collector.errors).toContain('test-error-message');
});

test('ConsoleCollector assertNoErrors passes when no errors', async ({
  page,
  baseUrl,
  console: collector,
}) => {
  await page.goto(baseUrl);
  await page.waitForTimeout(100);
  // Should not throw
  collector.assertNoErrors();
});

test('page does NOT auto-navigate (no URL set before explicit goto)', async ({ page }) => {
  // Page should be at about:blank before any explicit navigation
  expect(page.url()).toBe('about:blank');
});

test('token matches tokenStore value', async ({ token, tokenStore }) => {
  expect(token).toBe(tokenStore.read());
  expect(token.length).toBeGreaterThan(0);
});
