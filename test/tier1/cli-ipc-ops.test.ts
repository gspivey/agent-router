/**
 * Tier 1 unit tests for CLI IPC server op dispatch (task 16.2).
 *
 * Tests the createCliServer op handlers in isolation using a minimal stub
 * SessionManager and SessionFiles — no real Kiro subprocess, no fake backends.
 * Each test issues raw NDJSON over a real Unix socket to the running server and
 * asserts the response shape.
 *
 * Requirements: 21.3, 21.4, 21.5, 21.7
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { createCliServer, type CliServer } from '../../src/cli-server.js';
import type { SessionManager } from '../../src/session-mgr.js';
import type { SessionFiles, SessionMeta } from '../../src/session-files.js';
import type { Logger } from '../../src/log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let socketPath: string;
let server: CliServer;

/** Minimal stub SessionManager for IPC op tests. */
function makeStubSessionMgr(): SessionManager {
  const sessions = new Map<string, SessionMeta>();

  return {
    async createSession(prompt: string, repo?: string) {
      const id = `sess-${Math.random().toString(36).slice(2, 10)}`;
      const mockMeta: SessionMeta = {
        session_id: id,
        original_prompt: prompt,
        ...(repo !== undefined ? { repo } : {}),
        status: 'active',
        created_at: Math.floor(Date.now() / 1000),
        completed_at: null,
        prs: [],
      };
      sessions.set(id, mockMeta);
      return {
        sessionId: id,
        paths: {
          dir: path.join(tmpDir, 'sessions', id),
          meta: path.join(tmpDir, 'sessions', id, 'meta.json'),
          stream: path.join(tmpDir, 'sessions', id, 'stream.log'),
          prompts: path.join(tmpDir, 'sessions', id, 'prompts.log'),
        },
        acp: {} as never,
      };
    },
    async injectPrompt(sessionId: string, _prompt: string, _source: string) {
      if (!sessions.has(sessionId)) {
        throw new Error(`Session not found: ${sessionId}`);
      }
    },
    async terminateSession(sessionId: string) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`Session not found: ${sessionId}`);
      s.status = 'failed';
    },
    async completeSession(sessionId: string) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`Session not found: ${sessionId}`);
      s.status = 'completed';
    },
    async registerPR(_sessionId: string, _repo: string, _pr: number) {},
    async mergePR(_sessionId: string, _repo: string, _pr: number) {
      return { sha: 'abc123', message: 'merged' };
    },
    hasActiveSessionForRepo(_repo: string) { return false; },
    getActiveSession(_sessionId: string) { return null; },
    async shutdown() {},
    listActiveSessions() { return []; },
  } as unknown as SessionManager;
}

/** Minimal stub SessionFiles for IPC op tests. */
function makeStubSessionFiles(): SessionFiles {
  const metas = new Map<string, SessionMeta>();

  return {
    createSession(sessionId: string, prompt: string) {
      const dir = path.join(tmpDir, 'sessions', sessionId);
      fs.mkdirSync(dir, { recursive: true });
      const m: SessionMeta = {
        session_id: sessionId,
        original_prompt: prompt,
        status: 'active',
        created_at: Math.floor(Date.now() / 1000),
        completed_at: null,
        prs: [],
      };
      metas.set(sessionId, m);
      return {
        dir,
        meta: path.join(dir, 'meta.json'),
        stream: path.join(dir, 'stream.log'),
        prompts: path.join(dir, 'prompts.log'),
      };
    },
    readMeta(sessionId: string): SessionMeta {
      const m = metas.get(sessionId);
      if (!m) throw new Error(`No meta for ${sessionId}`);
      return m;
    },
    listSessions(): SessionMeta[] {
      return [...metas.values()];
    },
    // Stub out everything else
    updateMeta: () => {},
    appendStream: () => {},
    appendPrompt: () => {},
    writeWorktreeReapedAt: () => {},
  } as unknown as SessionFiles;
}

/** Minimal noop logger. */
function makeNullLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => makeNullLogger(),
  } as unknown as Logger;
}

/** Send a NDJSON request over a fresh socket connection and return the parsed response. */
async function ipcRequest(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = '';

    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          socket.destroy();
          resolve(JSON.parse(line) as Record<string, unknown>);
        }
      }
    });

    socket.on('error', reject);

    socket.on('connect', () => {
      socket.write(JSON.stringify(req) + '\n');
    });
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-ipc-ops-'));
  socketPath = path.join(tmpDir, 'sock');
  const mgr = makeStubSessionMgr();
  const sf = makeStubSessionFiles();
  const log = makeNullLogger();
  server = createCliServer({ socketPath, sessionMgr: mgr, sessionFiles: sf, log });
  await server.start();
});

afterEach(async () => {
  await server.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// new_session op
// ---------------------------------------------------------------------------

describe('CLI IPC: new_session op (task 16.2)', () => {
  it('returns session_id and paths on success', async () => {
    const resp = await ipcRequest({ op: 'new_session', prompt: 'Fix the bug' });
    expect(typeof resp['session_id']).toBe('string');
    expect((resp['session_id'] as string).length).toBeGreaterThan(0);
    expect(typeof resp['stream_path']).toBe('string');
    expect(typeof resp['prompts_path']).toBe('string');
  });

  it('returns an error when prompt is missing', async () => {
    const resp = await ipcRequest({ op: 'new_session' });
    expect(resp['error']).toBeDefined();
  });

  it('returns an error when prompt is empty', async () => {
    const resp = await ipcRequest({ op: 'new_session', prompt: '' });
    expect(resp['error']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// list_sessions op
// ---------------------------------------------------------------------------

describe('CLI IPC: list_sessions op (task 16.2)', () => {
  it('returns sessions array', async () => {
    const resp = await ipcRequest({ op: 'list_sessions' });
    expect(Array.isArray(resp['sessions'])).toBe(true);
  });

  it('returns empty array when no sessions exist', async () => {
    const resp = await ipcRequest({ op: 'list_sessions' });
    const sessions = resp['sessions'] as unknown[];
    expect(sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// inject_prompt op
// ---------------------------------------------------------------------------

describe('CLI IPC: inject_prompt op (task 16.2)', () => {
  it('returns ok:true when session exists', async () => {
    // First create a session
    const createResp = await ipcRequest({ op: 'new_session', prompt: 'Initial prompt' });
    const sessionId = createResp['session_id'] as string;

    const resp = await ipcRequest({
      op: 'inject_prompt',
      session_id: sessionId,
      prompt: 'Follow-up prompt',
    });
    expect(resp['ok']).toBe(true);
  });

  it('returns an error when session_id is missing', async () => {
    const resp = await ipcRequest({ op: 'inject_prompt', prompt: 'hello' });
    expect(resp['error']).toBeDefined();
  });

  it('returns an error when prompt is missing', async () => {
    const resp = await ipcRequest({ op: 'inject_prompt', session_id: 'some-id' });
    expect(resp['error']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// terminate_session op
// ---------------------------------------------------------------------------

describe('CLI IPC: terminate_session op (task 16.2)', () => {
  it('returns ok:true when session exists', async () => {
    const createResp = await ipcRequest({ op: 'new_session', prompt: 'To be killed' });
    const sessionId = createResp['session_id'] as string;

    const resp = await ipcRequest({ op: 'terminate_session', session_id: sessionId });
    expect(resp['ok']).toBe(true);
  });

  it('returns an error when session_id is missing', async () => {
    const resp = await ipcRequest({ op: 'terminate_session' });
    expect(resp['error']).toBeDefined();
  });
});
