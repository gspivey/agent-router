import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createACPClientFromStreams } from '../../../src/acp.js';

describe('ACPClient.cancel()', () => {
  it('writes correct JSON-RPC notification to stdin', async () => {
    const fakeStdin = new PassThrough();
    const fakeStdout = new PassThrough();
    const sessionEnded = new Promise<void>(() => {});

    const client = createACPClientFromStreams(fakeStdin, fakeStdout, sessionEnded);

    // Initialize and create a session to set acpSessionId
    const initPromise = client.initialize();
    // Respond to initialize
    fakeStdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\n');
    await initPromise;

    const newSessionPromise = client.newSession('/tmp');
    fakeStdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'test-session-123' } }) + '\n');
    await newSessionPromise;

    // Collect stdin writes
    const chunks: Buffer[] = [];
    fakeStdin.on('data', (chunk: Buffer) => { chunks.push(chunk); });

    // Call cancel
    client.cancel();

    // Wait a tick for the write to flush
    await new Promise((r) => setTimeout(r, 10));

    // Parse the last line written to stdin
    const allWritten = Buffer.concat(chunks).toString();
    const lines = allWritten.split('\n').filter((l) => l.trim());
    const lastLine = lines[lines.length - 1];
    const parsed = JSON.parse(lastLine!) as Record<string, unknown>;

    expect(parsed).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'test-session-123' },
    });
    // No `id` field — it's a notification, not a request
    expect(parsed).not.toHaveProperty('id');
  });

  it('is a no-op when session is idle (does not throw)', () => {
    const fakeStdin = new PassThrough();
    const fakeStdout = new PassThrough();
    const sessionEnded = new Promise<void>(() => {});

    const client = createACPClientFromStreams(fakeStdin, fakeStdout, sessionEnded);

    // cancel before any session is created — acpSessionId is empty string
    // Should not throw
    expect(() => client.cancel()).not.toThrow();
  });
});
