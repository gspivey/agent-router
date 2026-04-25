import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createACPClientFromStreams } from '../../src/acp.js';

function makeStreams() {
  const fakeStdout = new PassThrough(); // we write Kiro's output here
  const fakeStdin = new PassThrough(); // we read what the client sends to Kiro

  const written: string[] = [];
  fakeStdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

  const sessionEnded = new Promise<void>(() => {
    // never resolves — no real subprocess
  });

  const client = createACPClientFromStreams(fakeStdin, fakeStdout, sessionEnded);

  async function nextStdinLine(): Promise<unknown> {
    // Wait for at least one write then parse the first complete line
    await new Promise((r) => setTimeout(r, 20));
    const raw = written.join('').split('\n').filter(Boolean)[0];
    return JSON.parse(raw!);
  }

  function send(obj: unknown) {
    fakeStdout.write(JSON.stringify(obj) + '\n');
  }

  return { client, send, written, nextStdinLine };
}

describe('session/request_permission auto-approve', () => {
  it('sends a JSON-RPC response correlated by the request id', async () => {
    const { send, nextStdinLine } = makeStreams();

    send({
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: {
        options: [{ optionId: 'opt-once', kind: 'allow_once' }],
      },
    });

    const response = (await nextStdinLine()) as Record<string, unknown>;
    expect(response['jsonrpc']).toBe('2.0');
    expect(response['id']).toBe(42);
    expect(response['error']).toBeUndefined();
    expect((response['result'] as Record<string, unknown>)?.['outcome']).toBeDefined();
  });

  it('prefers allow_always when present alongside other options', async () => {
    const { send, written, nextStdinLine } = makeStreams();
    written.length = 0;

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/request_permission',
      params: {
        options: [
          { optionId: 'opt-reject', kind: 'reject_once' },
          { optionId: 'opt-once', kind: 'allow_once' },
          { optionId: 'opt-always', kind: 'allow_always' },
        ],
      },
    });

    const response = (await nextStdinLine()) as Record<string, unknown>;
    const result = response['result'] as Record<string, unknown>;
    const outcome = result['outcome'] as Record<string, unknown>;
    expect(outcome['optionId']).toBe('opt-always');
  });

  it('falls back to allow_once when allow_always is absent', async () => {
    const { send, written, nextStdinLine } = makeStreams();
    written.length = 0;

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/request_permission',
      params: {
        options: [
          { optionId: 'opt-reject', kind: 'reject_once' },
          { optionId: 'opt-once', kind: 'allow_once' },
        ],
      },
    });

    const response = (await nextStdinLine()) as Record<string, unknown>;
    const outcome = (response['result'] as Record<string, unknown>)['outcome'] as Record<string, unknown>;
    expect(outcome['optionId']).toBe('opt-once');
  });

  it('falls back to first option when neither preferred kind is present', async () => {
    const { send, written, nextStdinLine } = makeStreams();
    written.length = 0;

    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/request_permission',
      params: {
        options: [
          { optionId: 'opt-first', kind: 'something_else' },
          { optionId: 'opt-second', kind: 'another_kind' },
        ],
      },
    });

    const response = (await nextStdinLine()) as Record<string, unknown>;
    const outcome = (response['result'] as Record<string, unknown>)['outcome'] as Record<string, unknown>;
    expect(outcome['optionId']).toBe('opt-first');
  });

  it('returns JSON-RPC error when options array is empty', async () => {
    const { send, written, nextStdinLine } = makeStreams();
    written.length = 0;

    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/request_permission',
      params: { options: [] },
    });

    const response = (await nextStdinLine()) as Record<string, unknown>;
    expect(response['result']).toBeUndefined();
    const error = response['error'] as Record<string, unknown>;
    expect(error['code']).toBe(-32602);
  });

  it('notifications (no id field) flow into the notification queue without writing to stdin', async () => {
    const { client, send, written } = makeStreams();
    written.length = 0;

    send({
      jsonrpc: '2.0',
      method: 'session/progress',
      params: { message: 'working' },
    });

    await new Promise((r) => setTimeout(r, 20));

    // stdin should be untouched
    expect(written.join('')).toBe('');

    // notification should appear in the queue
    const iter = client.notifications[Symbol.asyncIterator]();
    const next = await Promise.race([
      iter.next(),
      new Promise<null>((r) => setTimeout(() => r(null), 50)),
    ]);
    expect(next).not.toBeNull();
    const item = next as IteratorResult<{ method: string }>;
    expect(item.value.method).toBe('session/progress');
  });

  it('response messages correlate to pending requests via pending.get(id)', async () => {
    const { client, send } = makeStreams();

    // Kick off an initialize request — it registers a pending entry
    const initPromise = client.initialize();

    await new Promise((r) => setTimeout(r, 10));

    // Feed back the correlated response (id: 1 is the first request)
    send({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: 1 },
    });

    // initialize() should resolve without throwing
    await expect(initPromise).resolves.toBeUndefined();
  });
});
