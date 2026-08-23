/**
 * Tier 1 tests: resumeSessions() unit tests.
 * Spec: .kiro/specs/session-recovery/ · task 6
 *
 * Tests the recovery logic with mock ACP clients (no subprocess spawning).
 * Covers:
 * - Zero active sessions → { 0, 0 }
 * - Session without kiro_session_id → abandoned with terminated_by_restart
 * - Session with kiro_session_id + loadSession succeeds → handle registered
 * - Session with kiro_session_id + loadSession throws → abandoned
 * - Multiple active sessions with mixed results
 * - Fresh inactivity and lifetime timers started for recovered sessions
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles, type SessionMeta } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import type { ACPClient, ACPNotification } from '../../src/acp.js';

let rootDir: string;
let dbPath: string;
let sf: SessionFiles;
let db: Database;
let log: Logger;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-recovery-t1-'));
  dbPath = path.join(rootDir, 'agent-router.db');
  sf = createSessionFiles(rootDir);
  db = initDatabase(dbPath);
  log = createLogger({ level: 'error', output: () => {} });
});

afterEach(async () => {
  await db.shutdown();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

/** Create a fake ACP client that succeeds on all operations. */
function createSucceedingACP(): ACPClient {
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
    sessionEnded: new Promise(() => {}),
    close: () => Promise.resolve(),
    kill: () => Promise.resolve(),
  } satisfies ACPClient;
}

/** Create a fake ACP client that throws on loadSession. */
function createFailingOnLoadACP(): ACPClient {
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
    loadSession: () => Promise.reject(new Error('Session not found on Kiro side')),
    sendPrompt: () => Promise.resolve(),
    cancel: () => {},
    notifications: { [Symbol.asyncIterator]() { return neverEndingIterator; } } as AsyncIterable<ACPNotification>,
    sessionEnded: new Promise(() => {}),
    close: () => Promise.resolve(),
    kill: () => Promise.resolve(),
  } satisfies ACPClient;
}

/** Create a fake ACP client that throws on initialize. */
function createFailingOnInitACP(): ACPClient {
  const neverEndingIterator: AsyncIterableIterator<ACPNotification> = {
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise<IteratorResult<ACPNotification>>(() => {}); },
    return() { return Promise.resolve({ done: true, value: undefined }); },
    throw() { return Promise.resolve({ done: true, value: undefined }); },
  };

  return {
    initialize: () => Promise.reject(new Error('ACP protocol version mismatch')),
    newSession: () => Promise.resolve('fake-session-id'),
    newSessionWithPrompt: () => Promise.resolve('fake-session-id'),
    loadSession: () => Promise.resolve(),
    sendPrompt: () => Promise.resolve(),
    cancel: () => {},
    notifications: { [Symbol.asyncIterator]() { return neverEndingIterator; } } as AsyncIterable<ACPNotification>,
    sessionEnded: new Promise(() => {}),
    close: () => Promise.resolve(),
    kill: () => Promise.resolve(),
  } satisfies ACPClient;
}

/**
 * Plant an active session on disk (simulating pre-crash state).
 */
function plantActiveSession(sessionId: string, opts?: { kiroSessionId?: string; repo?: string }): void {
  const paths = sf.createSession(sessionId, 'Test prompt');
  const meta: SessionMeta = {
    session_id: sessionId,
    original_prompt: 'Test prompt',
    status: 'active',
    created_at: Math.floor(Date.now() / 1000) - 60,
    completed_at: null,
    prs: [],
    ...(opts?.repo !== undefined ? { repo: opts.repo } : {}),
    ...(opts?.kiroSessionId !== undefined ? { kiro_session_id: opts.kiroSessionId } : {}),
  };
  fs.writeFileSync(paths.meta, JSON.stringify(meta, null, 2) + '\n');
}

describe('resumeSessions — Spec Task 6', () => {
  it('returns { resumed: 0, terminated: 0 } when no active sessions exist (Req 5.1)', async () => {
    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createSucceedingACP(),
      log,
    });

    try {
      const result = await mgr.resumeSessions();
      expect(result).toEqual({ resumed: 0, terminated: 0 });
    } finally {
      await mgr.shutdown();
    }
  });

  it('returns { resumed: 0, terminated: 0 } when only terminal sessions exist (Req 5.1)', async () => {
    sf.createSession('sess-done', 'Done');
    sf.updateMeta('sess-done', {
      status: 'completed',
      completed_at: Math.floor(Date.now() / 1000),
      termination_reason: 'completed',
    });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createSucceedingACP(),
      log,
    });

    try {
      const result = await mgr.resumeSessions();
      expect(result).toEqual({ resumed: 0, terminated: 0 });
    } finally {
      await mgr.shutdown();
    }
  });

  it('marks session abandoned when kiro_session_id is missing (Req 2.1, 2.3)', async () => {
    plantActiveSession('sess-no-id');

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createSucceedingACP(),
      log,
    });

    try {
      const result = await mgr.resumeSessions();
      expect(result).toEqual({ resumed: 0, terminated: 1 });

      // Not in registry
      expect(mgr.getActiveSession('sess-no-id')).toBeNull();

      // Meta updated correctly
      const meta = sf.readMeta('sess-no-id');
      expect(meta.status).toBe('abandoned');
      expect(meta.termination_reason).toBe('terminated_by_restart');
      expect(meta.completed_at).not.toBeNull();

      // Stream has session_ended entry
      const streamPath = sf.getSessionPaths('sess-no-id').stream;
      const lines = fs.readFileSync(streamPath, 'utf-8').trim().split('\n').filter(Boolean);
      const endEntry = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((e) => e['type'] === 'session_ended');
      expect(endEntry).toBeDefined();
      expect(endEntry!['reason']).toBe('terminated_by_restart');
      expect(endEntry!['source']).toBe('router');
    } finally {
      await mgr.shutdown();
    }
  });

  it('marks session abandoned when kiro_session_id is empty string (Req 2.1)', async () => {
    plantActiveSession('sess-empty-id', { kiroSessionId: '' });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createSucceedingACP(),
      log,
    });

    try {
      const result = await mgr.resumeSessions();
      expect(result).toEqual({ resumed: 0, terminated: 1 });

      const meta = sf.readMeta('sess-empty-id');
      expect(meta.status).toBe('abandoned');
      expect(meta.termination_reason).toBe('terminated_by_restart');
    } finally {
      await mgr.shutdown();
    }
  });

  it('registers handle in registry when loadSession succeeds (Req 1.3, 1.4)', async () => {
    plantActiveSession('sess-ok', { kiroSessionId: 'kiro-abc-123' });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createSucceedingACP(),
      log,
    });

    try {
      const result = await mgr.resumeSessions();
      expect(result).toEqual({ resumed: 1, terminated: 0 });

      // Session is in the active registry
      const handle = mgr.getActiveSession('sess-ok');
      expect(handle).not.toBeNull();
      expect(handle!.sessionId).toBe('sess-ok');
      expect(handle!.acp).toBeDefined();
      expect(handle!.eventQueue).toBeDefined();
      expect(handle!.turnQueue).toBeDefined();

      // Meta is still active (not modified on success)
      const meta = sf.readMeta('sess-ok');
      expect(meta.status).toBe('active');
    } finally {
      await mgr.shutdown();
    }
  });

  it('marks session abandoned when loadSession throws (Req 2.2, 2.3)', async () => {
    plantActiveSession('sess-fail', { kiroSessionId: 'kiro-stale' });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createFailingOnLoadACP(),
      log,
    });

    try {
      const result = await mgr.resumeSessions();
      expect(result).toEqual({ resumed: 0, terminated: 1 });

      expect(mgr.getActiveSession('sess-fail')).toBeNull();

      const meta = sf.readMeta('sess-fail');
      expect(meta.status).toBe('abandoned');
      expect(meta.termination_reason).toBe('terminated_by_restart');
      expect(meta.completed_at).not.toBeNull();
    } finally {
      await mgr.shutdown();
    }
  });

  it('marks session abandoned when initialize() throws (Req 2.2)', async () => {
    plantActiveSession('sess-init-fail', { kiroSessionId: 'kiro-xyz' });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createFailingOnInitACP(),
      log,
    });

    try {
      const result = await mgr.resumeSessions();
      expect(result).toEqual({ resumed: 0, terminated: 1 });

      const meta = sf.readMeta('sess-init-fail');
      expect(meta.status).toBe('abandoned');
      expect(meta.termination_reason).toBe('terminated_by_restart');
    } finally {
      await mgr.shutdown();
    }
  });

  it('handles mixed sessions: some resume, some fail (Req 2.5)', async () => {
    plantActiveSession('sess-a', { kiroSessionId: 'kiro-a' }); // will succeed
    plantActiveSession('sess-b'); // no kiro_session_id → terminated
    plantActiveSession('sess-c', { kiroSessionId: 'kiro-c' }); // will succeed

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createSucceedingACP(),
      log,
    });

    try {
      const result = await mgr.resumeSessions();
      expect(result.resumed).toBe(2);
      expect(result.terminated).toBe(1);

      expect(mgr.getActiveSession('sess-a')).not.toBeNull();
      expect(mgr.getActiveSession('sess-b')).toBeNull();
      expect(mgr.getActiveSession('sess-c')).not.toBeNull();
    } finally {
      await mgr.shutdown();
    }
  });

  it('continues processing after individual failure (Req 2.5)', async () => {
    // First session will fail (bad kiro_session_id), second will succeed
    plantActiveSession('sess-first', { kiroSessionId: 'kiro-bad' });
    plantActiveSession('sess-second', { kiroSessionId: 'kiro-good' });

    let callCount = 0;
    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => {
        callCount++;
        // First call fails on loadSession, second succeeds
        if (callCount === 1) {
          return createFailingOnLoadACP();
        }
        return createSucceedingACP();
      },
      log,
    });

    try {
      const result = await mgr.resumeSessions();
      // Regardless of which order they're processed, one fails and one succeeds
      expect(result.resumed + result.terminated).toBe(2);
      expect(result.terminated).toBeGreaterThanOrEqual(1);
    } finally {
      await mgr.shutdown();
    }
  });

  it('starts fresh inactivity and lifetime timers for recovered sessions (Req 4.1, 4.2)', async () => {
    plantActiveSession('sess-timers', { kiroSessionId: 'kiro-timer-test' });

    // Use a very short inactivity timeout to verify the timer fires
    const SHORT_INACTIVITY_MS = 200; // 200ms
    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createSucceedingACP(),
      log,
      sessionTimeout: {
        inactivityMinutes: SHORT_INACTIVITY_MS / 60_000, // convert ms to minutes
        maxLifetimeMinutes: 120,
        gracePeriodAfterMergeSeconds: 60,
      },
    });

    try {
      const result = await mgr.resumeSessions();
      expect(result.resumed).toBe(1);

      // Session is active immediately after resume
      expect(mgr.getActiveSession('sess-timers')).not.toBeNull();

      // Wait for the inactivity timer to fire (it should trigger within ~200ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 500));

      // After inactivity timeout, session should have been terminated
      // The session should no longer be in the active registry
      expect(mgr.getActiveSession('sess-timers')).toBeNull();

      // Meta should reflect timeout
      const meta = sf.readMeta('sess-timers');
      expect(meta.status).not.toBe('active');
    } finally {
      await mgr.shutdown();
    }
  });

  it('preserves original created_at timestamp (Req 4.3)', async () => {
    const originalCreatedAt = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const paths = sf.createSession('sess-ts', 'Test');
    const meta: SessionMeta = {
      session_id: 'sess-ts',
      original_prompt: 'Test',
      status: 'active',
      created_at: originalCreatedAt,
      completed_at: null,
      prs: [],
      kiro_session_id: 'kiro-ts',
    };
    fs.writeFileSync(paths.meta, JSON.stringify(meta, null, 2) + '\n');

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createSucceedingACP(),
      log,
    });

    try {
      await mgr.resumeSessions();

      const updatedMeta = sf.readMeta('sess-ts');
      expect(updatedMeta.created_at).toBe(originalCreatedAt);
    } finally {
      await mgr.shutdown();
    }
  });

  it('does not append session_started stream entry on successful recovery (Req 6.3)', async () => {
    plantActiveSession('sess-no-start', { kiroSessionId: 'kiro-ns' });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createSucceedingACP(),
      log,
    });

    try {
      await mgr.resumeSessions();

      // Read stream.log — should NOT have a session_started entry from recovery
      const streamPath = sf.getSessionPaths('sess-no-start').stream;
      const content = fs.readFileSync(streamPath, 'utf-8').trim();
      if (content.length > 0) {
        const entries = content.split('\n').filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        const startEntries = entries.filter((e) => e['type'] === 'session_started');
        // Only the original session_started from createSession should exist
        expect(startEntries.length).toBeLessThanOrEqual(1);
      }
    } finally {
      await mgr.shutdown();
    }
  });

  it('sets terminal_at on abandoned sessions for reaper (Req 2.3)', async () => {
    plantActiveSession('sess-reaper', { kiroSessionId: '' });

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createSucceedingACP(),
      log,
    });

    try {
      await mgr.resumeSessions();

      const meta = sf.readMeta('sess-reaper');
      expect(meta.terminal_at).toBeDefined();
      expect(typeof meta.terminal_at).toBe('number');
      expect(meta.terminal_at!).toBeGreaterThan(0);
    } finally {
      await mgr.shutdown();
    }
  });

  it('preserves bound_project metadata on resumed sessions (Req 1.4)', async () => {
    const paths = sf.createSession('sess-bound', 'Test');
    const meta: SessionMeta = {
      session_id: 'sess-bound',
      original_prompt: 'Test',
      status: 'active',
      created_at: Math.floor(Date.now() / 1000) - 60,
      completed_at: null,
      prs: [],
      kiro_session_id: 'kiro-bound',
      repo: 'org/repo',
      bound_project: 'my-project',
      bound_project_repos: ['org/repo', 'org/lib'],
    };
    fs.writeFileSync(paths.meta, JSON.stringify(meta, null, 2) + '\n');

    const mgr = createSessionManager({
      db,
      sessionFiles: sf,
      acpSpawner: () => createSucceedingACP(),
      log,
    });

    try {
      await mgr.resumeSessions();

      const handle = mgr.getActiveSession('sess-bound');
      expect(handle).not.toBeNull();
      expect(handle!.boundProject).toBe('my-project');
      expect(handle!.boundProjectRepos).toEqual(['org/repo', 'org/lib']);
      expect(handle!.repo).toBe('org/repo');
    } finally {
      await mgr.shutdown();
    }
  });
});
