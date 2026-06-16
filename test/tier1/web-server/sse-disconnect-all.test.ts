import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSSEBroker, type SSEBroker } from '../../../src/sse-broker.js';
import { createSessionFiles, type SessionFiles } from '../../../src/session-files.js';
import { createLogger } from '../../../src/log.js';

describe('SSEBroker.disconnectAll', () => {
  let rootDir: string;
  let sessionFiles: SessionFiles;
  let broker: SSEBroker;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-disconnect-'));
    sessionFiles = createSessionFiles(rootDir);
    const log = createLogger({ level: 'error', output: () => {} });
    broker = createSSEBroker({ sessionFiles, rootDir, log, pollIntervalMs: 50 });
  });

  afterEach(() => {
    broker.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('closes all clients for the given session', () => {
    const sessionId = 'test-session-1';
    const sessDir = path.join(rootDir, 'sessions', sessionId);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'stream.log'), '');
    fs.writeFileSync(
      path.join(sessDir, 'meta.json'),
      JSON.stringify({ status: 'active', created_at: Date.now() }),
    );

    const closed: string[] = [];
    broker.subscribe(sessionId, undefined, () => {}, () => { closed.push('client1'); });
    broker.subscribe(sessionId, undefined, () => {}, () => { closed.push('client2'); });

    broker.disconnectAll(sessionId);

    expect(closed).toEqual(['client1', 'client2']);
  });

  it('is a no-op for unknown session', () => {
    // Should not throw
    broker.disconnectAll('nonexistent');
  });

  it('stops poll timer after disconnect', (ctx) => {
    const sessionId = 'test-session-2';
    const sessDir = path.join(rootDir, 'sessions', sessionId);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'stream.log'), '');
    fs.writeFileSync(
      path.join(sessDir, 'meta.json'),
      JSON.stringify({ status: 'active', created_at: Date.now() }),
    );

    const writes: string[] = [];
    broker.subscribe(sessionId, undefined, (chunk) => { writes.push(chunk); }, () => {});

    // Append a line — broker should deliver it
    fs.appendFileSync(path.join(sessDir, 'stream.log'), '{"type":"test","ts":"1"}\n');

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const beforeCount = writes.length;
        broker.disconnectAll(sessionId);

        // Append another line — should NOT be delivered (no clients)
        fs.appendFileSync(path.join(sessDir, 'stream.log'), '{"type":"test2","ts":"2"}\n');

        setTimeout(() => {
          // No new writes after disconnect
          expect(writes.length).toBe(beforeCount);
          resolve();
        }, 150);
      }, 100);
    });
  });

  it('does not emit session_ended event', () => {
    const sessionId = 'test-session-3';
    const sessDir = path.join(rootDir, 'sessions', sessionId);
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'stream.log'), '{"type":"log","ts":"1"}\n');
    fs.writeFileSync(
      path.join(sessDir, 'meta.json'),
      JSON.stringify({ status: 'active', created_at: Date.now() }),
    );

    const writes: string[] = [];
    broker.subscribe(sessionId, undefined, (chunk) => { writes.push(chunk); }, () => {});

    broker.disconnectAll(sessionId);

    // Verify none of the written chunks contain 'session_ended' event type
    const allOutput = writes.join('');
    expect(allOutput).not.toContain('event: session_ended');
  });
});
