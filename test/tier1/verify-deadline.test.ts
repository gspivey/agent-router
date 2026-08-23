/**
 * Tier 1 property test: verify deadline in inactivity timer.
 *
 * Property: A verify() function that never resolves MUST NOT prevent the
 * inactivity handler from completing. The handler must terminate the session
 * within (inactivityTimeout + verifyDeadlineMs + buffer).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSessionManager, DEFAULT_VERIFY_DEADLINE_MS } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles, type SessionMeta } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import type { ACPClient, ACPNotification } from '../../src/acp.js';
import type { VerifySessionFn, VerifyResult } from '../../src/verify-session.js';

let rootDir: string;
let dbPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-deadline-tier1-'));
  dbPath = path.join(rootDir, 'agent-router.db');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });
});

afterEach(async () => {
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

/** Create a minimal fake ACP client that does nothing. */
function createFakeACP(): ACPClient {
  const neverEndingIterator: AsyncIterableIterator<ACPNotification> = {
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise<IteratorResult<ACPNotification>>(() => {}); },
    return() { return Promise.resolve({ done: true, value: undefined }); },
    throw() { return Promise.resolve({ done: true, value: undefined }); },
  };

  return {
    initialize: () => Promise.resolve(),
    newSession: () => Promise.resolve('fake-session-id'),
    newSessionWithPrompt: () => Promise.resolve('fake-session-id'),
    loadSession: () => Promise.resolve(),
    sendPrompt: () => Promise.resolve(),
    cancel: () => {},
    notifications: { [Symbol.asyncIterator]() { return neverEndingIterator; } } as AsyncIterable<ACPNotification>,
    sessionEnded: new Promise(() => {}), // never resolves
    close: () => Promise.resolve(),
    kill: () => Promise.resolve(),
  } satisfies ACPClient;
}

describe('verify deadline in inactivity timer', () => {
  it('exports DEFAULT_VERIFY_DEADLINE_MS as 30_000', () => {
    expect(DEFAULT_VERIFY_DEADLINE_MS).toBe(30_000);
  });

  it('property: hanging verify does not prevent inactivity handler from completing', async () => {
    // Use a very short inactivity timeout (100ms) and a short verify deadline (200ms).
    // A verify that never resolves should still allow the handler to terminate the
    // session within (100ms + 200ms + buffer).
    const INACTIVITY_MS = 100;
    const VERIFY_DEADLINE_MS = 200;
    const MAX_EXPECTED_MS = INACTIVITY_MS + VERIFY_DEADLINE_MS + 500; // generous buffer

    // Property: for any verify function that never resolves, the session
    // terminates within the deadline.
    await fc.assert(
      fc.asyncProperty(
        fc.constant(null), // no meaningful arbitrary needed; the property is deterministic
        async () => {
          const hangingVerify: VerifySessionFn = () => new Promise<VerifyResult>(() => {
            // Never resolves
          });

          const mgr = createSessionManager({
            db,
            sessionFiles: sf,
            acpSpawner: () => createFakeACP(),
            log,
            sessionTimeout: {
              inactivityMinutes: INACTIVITY_MS / 60_000,
              maxLifetimeMinutes: 60,
              gracePeriodAfterMergeSeconds: 60,
            },
            verify: hangingVerify,
            verifyDeadlineMs: VERIFY_DEADLINE_MS,
          });

          const handle = await mgr.createSession('test prompt');
          const sessionId = handle.sessionId;

          // Wait for inactivity + verify deadline + buffer
          const start = Date.now();
          await new Promise<void>((resolve) => {
            const check = setInterval(() => {
              const active = mgr.getActiveSession(sessionId);
              if (active === null || Date.now() - start > MAX_EXPECTED_MS) {
                clearInterval(check);
                resolve();
              }
            }, 50);
          });

          const elapsed = Date.now() - start;

          // Session must have been terminated
          const active = mgr.getActiveSession(sessionId);
          expect(active).toBeNull();

          // It must have completed within the expected time bound
          expect(elapsed).toBeLessThan(MAX_EXPECTED_MS);

          // meta.json should show timeout_inactivity
          const meta = sf.readMeta(sessionId) as SessionMeta & { termination_reason?: string };
          expect(meta.status).toBe('failed');
          expect(meta.termination_reason).toBe('timeout_inactivity');

          await mgr.shutdown();
        },
      ),
      { numRuns: 10 }, // Lower count due to real timers; 10 runs is plenty for this property
    );
  }, 30_000);

  it('verify that resolves normally still works', async () => {
    const normalVerify: VerifySessionFn = () =>
      Promise.resolve({ verified: false, reason: 'no_prs' as const });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createFakeACP(),
      log,
      sessionTimeout: {
        inactivityMinutes: 100 / 60_000, // 100ms
        maxLifetimeMinutes: 60,
        gracePeriodAfterMergeSeconds: 60,
      },
      verify: normalVerify,
      verifyDeadlineMs: 5000, // generous deadline that won't fire
    });

    const handle = await mgr.createSession('test prompt');

    // Wait for inactivity timer to fire + verify to complete
    await new Promise((r) => setTimeout(r, 1000));

    const active = mgr.getActiveSession(handle.sessionId);
    expect(active).toBeNull();

    const meta = sf.readMeta(handle.sessionId) as SessionMeta & { termination_reason?: string };
    expect(meta.status).toBe('failed');
    expect(meta.termination_reason).toBe('timeout_inactivity');

    await mgr.shutdown();
  }, 10_000);

  it('verify that rejects (throws) still terminates normally', async () => {
    const throwingVerify: VerifySessionFn = () =>
      Promise.reject(new Error('GitHub exploded'));

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createFakeACP(),
      log,
      sessionTimeout: {
        inactivityMinutes: 100 / 60_000, // 100ms
        maxLifetimeMinutes: 60,
        gracePeriodAfterMergeSeconds: 60,
      },
      verify: throwingVerify,
      verifyDeadlineMs: 5000,
    });

    const handle = await mgr.createSession('test prompt');

    await new Promise((r) => setTimeout(r, 1000));

    const active = mgr.getActiveSession(handle.sessionId);
    expect(active).toBeNull();

    const meta = sf.readMeta(handle.sessionId) as SessionMeta & { termination_reason?: string };
    expect(meta.status).toBe('failed');
    expect(meta.termination_reason).toBe('timeout_inactivity');

    await mgr.shutdown();
  }, 10_000);
});
