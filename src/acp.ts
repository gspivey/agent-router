import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import type { StreamEntry } from './session-files.js';

export interface ACPNotification {
  method: string;
  params: unknown;
}

export interface ACPClient {
  initialize(): Promise<void>;
  loadSession(sessionId: string): Promise<void>;
  sendPrompt(prompt: string): Promise<void>;
  readonly notifications: AsyncIterable<ACPNotification>;
  readonly sessionEnded: Promise<void>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

/** JSON-RPC 2.0 request (client → agent) */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response (agent → client) */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 notification (agent → client, no id) */
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && typeof (msg as JsonRpcResponse).id === 'number';
}

/**
 * Pending request waiting for a JSON-RPC response correlated by id.
 */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Simple async queue that backs the AsyncIterable<ACPNotification> interface.
 * Notifications are pushed by the framing layer and consumed by the session manager.
 */
class NotificationQueue {
  private queue: ACPNotification[] = [];
  private waiters: Array<(value: IteratorResult<ACPNotification>) => void> = [];
  private done = false;

  push(notification: ACPNotification): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: notification, done: false });
    } else {
      this.queue.push(notification);
    }
  }

  end(): void {
    this.done = true;
    // Resolve all pending waiters with done
    for (const waiter of this.waiters) {
      waiter({ value: undefined as unknown as ACPNotification, done: true });
    }
    this.waiters.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<ACPNotification> {
    return {
      next: (): Promise<IteratorResult<ACPNotification>> => {
        const queued = this.queue.shift();
        if (queued) {
          return Promise.resolve({ value: queued, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as ACPNotification, done: true });
        }
        return new Promise<IteratorResult<ACPNotification>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

export interface SpawnACPClientOptions {
  onStderr?: (entry: StreamEntry) => void;
}

export function spawnACPClient(
  kiroPath: string,
  args: string[],
  env?: Record<string, string>,
  options?: SpawnACPClientOptions,
): ACPClient {
  const child: ChildProcess = spawn(kiroPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : undefined,
  });

  const stdin = child.stdin!;
  const stdout = child.stdout!;
  const stderr = child.stderr!;

  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  const notificationQueue = new NotificationQueue();

  // --- sessionEnded promise: resolves when subprocess exits ---
  const sessionEnded = new Promise<void>((resolve) => {
    child.on('close', () => {
      resolve();
    });
  });

  // --- stderr line capture ---
  const stderrRl = createInterface({ input: stderr, terminal: false });
  stderrRl.on('line', (line: string) => {
    if (options?.onStderr) {
      const entry: StreamEntry = {
        ts: new Date().toISOString(),
        source: 'agent',
        type: 'stderr',
        content: line,
      };
      options.onStderr(entry);
    }
  });

  // --- JSON-RPC framing: read newline-delimited JSON from stdout ---
  const stdoutRl = createInterface({ input: stdout, terminal: false });

  stdoutRl.on('line', (line: string) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // skip malformed lines
    }

    if (isResponse(msg)) {
      // Correlate response to pending request by id
      const req = pending.get(msg.id);
      if (req) {
        pending.delete(msg.id);
        if (msg.error) {
          req.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
        } else {
          req.resolve(msg.result);
        }
      }
    } else {
      // It's a notification (no id field)
      const notification = msg as JsonRpcNotification;

      // Auto-approve session/request_permission
      if (notification.method === 'session/request_permission') {
        autoApprovePermission(notification);
        return;
      }

      notificationQueue.push({
        method: notification.method,
        params: notification.params,
      });
    }
  });

  // When stdout closes, end the notification queue and reject pending requests
  stdoutRl.on('close', () => {
    notificationQueue.end();
    for (const [id, req] of pending) {
      pending.delete(id);
      req.reject(new Error('Subprocess stdout closed before response received'));
    }
  });

  // --- Helper: send a JSON-RPC request and wait for the correlated response ---
  function sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      stdin.write(JSON.stringify(request) + '\n', (err) => {
        if (err) {
          pending.delete(id);
          reject(new Error(`Failed to write to subprocess stdin: ${err.message}`));
        }
      });
    });
  }

  // --- Auto-approve session/request_permission ---
  function autoApprovePermission(notification: JsonRpcNotification): void {
    // Permission requests come as notifications with an id-like field in params
    // We send back a JSON-RPC response approving the request
    const params = notification.params as Record<string, unknown> | undefined;
    const requestId = params?.['id'];
    if (typeof requestId === 'number') {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: requestId,
        result: { approved: true },
      };
      stdin.write(JSON.stringify(response) + '\n');
    }
    // Also push it as a notification so consumers can observe it
    notificationQueue.push({
      method: notification.method,
      params: notification.params,
    });
  }

  return {
    async initialize(): Promise<void> {
      const result = await sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: ['fs.readTextFile', 'fs.writeTextFile', 'terminal'],
      });
      // Check for protocol version mismatch
      const response = result as Record<string, unknown> | null | undefined;
      if (response && typeof response['protocolVersion'] === 'number' && response['protocolVersion'] !== 1) {
        // Version mismatch — close subprocess
        stdin.end();
        await sessionEnded;
        throw new Error(`ACP protocol version mismatch: expected 1, got ${response['protocolVersion']}`);
      }
    },

    async loadSession(sessionId: string): Promise<void> {
      await sendRequest('session/load', { sessionId });
    },

    async sendPrompt(prompt: string): Promise<void> {
      await sendRequest('session/prompt', { prompt });
    },

    get notifications(): AsyncIterable<ACPNotification> {
      return notificationQueue;
    },

    get sessionEnded(): Promise<void> {
      return sessionEnded;
    },

    async close(): Promise<void> {
      stdin.end();
      await sessionEnded;
    },

    async kill(): Promise<void> {
      // SIGTERM first
      child.kill('SIGTERM');
      // Wait up to 5 seconds for exit
      const timeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 5000),
      );
      const result = await Promise.race([sessionEnded.then(() => 'exited' as const), timeout]);
      if (result === 'timeout') {
        child.kill('SIGKILL');
        await sessionEnded;
      }
    },
  };
}
