import * as net from 'node:net';
import { createInterface } from 'node:readline';

export interface McpContext {
  sessionId: string;
  daemonSocket: string;
}

export interface McpServer {
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

/** JSON-RPC 2.0 request from MCP client */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response to MCP client */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Tool definition for MCP tools/list */
interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'session_status',
    description: 'Get the current session status including original prompt, registered PRs, and session state.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'register_pr',
    description: 'Register a pull request with the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in "owner/name" format' },
        pr_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['repo', 'pr_number'],
    },
  },
  {
    name: 'complete_session',
    description: 'Signal that the session is complete.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Reason for completing the session' },
      },
      required: ['reason'],
    },
  },
];

/**
 * Send a request to the daemon's Unix socket and return the parsed response.
 */
function sendToDaemon(socketPath: string, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(msg) + '\n');
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        socket.destroy();
        try {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } catch (e: unknown) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });

    socket.on('error', (err: Error) => {
      reject(err);
    });

    socket.on('close', () => {
      if (buffer.trim()) {
        try {
          resolve(JSON.parse(buffer.trim()) as Record<string, unknown>);
        } catch {
          reject(new Error('Socket closed without valid response'));
        }
      }
    });
  });
}

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function makeErrorResponse(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function makeSuccessResponse(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function createMcpServer(ctx: McpContext): McpServer {
  const { sessionId, daemonSocket } = ctx;
  let running = false;
  let rl: ReturnType<typeof createInterface> | null = null;

  async function handleInitialize(req: JsonRpcRequest): Promise<void> {
    writeResponse(makeSuccessResponse(req.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'agent-router-mcp',
        version: '0.1.0',
      },
    }));
  }

  async function handleToolsList(req: JsonRpcRequest): Promise<void> {
    writeResponse(makeSuccessResponse(req.id, { tools: MCP_TOOLS }));
  }

  async function handleToolsCall(req: JsonRpcRequest): Promise<void> {
    const params = req.params as Record<string, unknown> | undefined;
    const toolName = params?.['name'];
    const toolArgs = (params?.['arguments'] ?? {}) as Record<string, unknown>;

    if (typeof toolName !== 'string') {
      writeResponse(makeErrorResponse(req.id, -32602, 'Missing tool name'));
      return;
    }

    try {
      let result: Record<string, unknown>;

      switch (toolName) {
        case 'session_status': {
          result = await sendToDaemon(daemonSocket, {
            op: 'session_status',
            session_id: sessionId,
          });
          break;
        }
        case 'register_pr': {
          const repo = toolArgs['repo'];
          const prNumber = toolArgs['pr_number'];
          if (typeof repo !== 'string' || repo.length === 0) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or empty "repo" argument' }) }],
              isError: true,
            }));
            return;
          }
          if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or invalid "pr_number" argument' }) }],
              isError: true,
            }));
            return;
          }
          result = await sendToDaemon(daemonSocket, {
            op: 'register_pr',
            session_id: sessionId,
            repo,
            pr_number: prNumber,
          });
          break;
        }
        case 'complete_session': {
          const reason = toolArgs['reason'];
          if (typeof reason !== 'string' || reason.length === 0) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or empty "reason" argument' }) }],
              isError: true,
            }));
            return;
          }
          result = await sendToDaemon(daemonSocket, {
            op: 'complete_session',
            session_id: sessionId,
            reason,
          });
          break;
        }
        default: {
          writeResponse(makeErrorResponse(req.id, -32601, `Unknown tool: ${toolName}`));
          return;
        }
      }

      if (result['error']) {
        writeResponse(makeSuccessResponse(req.id, {
          content: [{ type: 'text', text: JSON.stringify({ error: result['error'] }) }],
          isError: true,
        }));
      } else {
        writeResponse(makeSuccessResponse(req.id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        }));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      writeResponse(makeSuccessResponse(req.id, {
        content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
        isError: true,
      }));
    }
  }

  async function handleRequest(req: JsonRpcRequest): Promise<void> {
    switch (req.method) {
      case 'initialize':
        await handleInitialize(req);
        break;
      case 'tools/list':
        await handleToolsList(req);
        break;
      case 'tools/call':
        await handleToolsCall(req);
        break;
      case 'notifications/initialized':
        // Client acknowledgement — no response needed for notifications
        break;
      default:
        writeResponse(makeErrorResponse(req.id, -32601, `Method not found: ${req.method}`));
        break;
    }
  }

  return {
    async start(): Promise<void> {
      running = true;
      rl = createInterface({ input: process.stdin, terminal: false });

      rl.on('line', (line: string) => {
        if (!line.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          writeResponse(makeErrorResponse(null, -32700, 'Parse error'));
          return;
        }

        const obj = parsed as Record<string, unknown>;
        if (typeof obj['method'] !== 'string') {
          if ('id' in obj) {
            writeResponse(makeErrorResponse(obj['id'] as number | string, -32600, 'Invalid request'));
          }
          return;
        }

        // Notifications don't have an id — handle them but don't respond
        if (!('id' in obj)) {
          const notif: JsonRpcRequest = { jsonrpc: '2.0', id: 0, method: obj['method'], params: obj['params'] };
          handleRequest(notif).catch(() => {});
          return;
        }

        const req: JsonRpcRequest = { jsonrpc: '2.0', id: obj['id'] as number | string, method: obj['method'], params: obj['params'] };
        handleRequest(req).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          writeResponse(makeErrorResponse(req.id, -32603, msg));
        });
      });

      // Wait until stdin closes or shutdown is called
      await new Promise<void>((resolve) => {
        rl!.on('close', () => {
          running = false;
          resolve();
        });
      });
    },

    async shutdown(): Promise<void> {
      running = false;
      if (rl) {
        rl.close();
        rl = null;
      }
    },
  };
}

// --- Standalone entry point ---
// When run directly, read AGENT_ROUTER_SESSION_ID and AGENT_ROUTER_SOCKET from env
const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith('mcp-server.ts') || process.argv[1].endsWith('mcp-server.js'));

if (isMainModule) {
  const envSessionId = process.env['AGENT_ROUTER_SESSION_ID'];
  const envSocket = process.env['AGENT_ROUTER_SOCKET'];

  if (!envSessionId) {
    process.stderr.write('AGENT_ROUTER_SESSION_ID environment variable is required\n');
    process.exit(1);
  }
  if (!envSocket) {
    process.stderr.write('AGENT_ROUTER_SOCKET environment variable is required\n');
    process.exit(1);
  }

  const server = createMcpServer({
    sessionId: envSessionId,
    daemonSocket: envSocket,
  });

  server.start().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`MCP server error: ${msg}\n`);
    process.exit(1);
  });
}
