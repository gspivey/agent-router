import * as net from 'node:net';
import { createInterface } from 'node:readline';
import type { Logger } from './log.js';

export interface McpContext {
  sessionId: string;
  /** Operator/daemon socket (session_status, register_pr, merge_pr, …). */
  daemonSocket: string;
  log?: Logger;
  /**
   * Agent socket path for the credential-boundary relays
   * (`github_http_forward`, `push_branch`, `pr_create`, `pr_view`). When
   * omitted, resolved from `AGENT_ROUTER_AGENT_SOCK` / `AGENT_ROUTER_SOCKET`
   * at call time. Agent process isolation, FR-5.2 / FR-6.2.
   */
  agentSocket?: string;
  /**
   * Per-session capability token presented to the agent socket. When omitted,
   * resolved from `AGENT_ROUTER_CAP_TOKEN` at call time (FR-4.4).
   */
  capToken?: string;
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
    name: 'merge_pr',
    description:
      'Squash-merge a pull request via the GitHub API. The PR must have been registered with this session via register_pr. Use this instead of running `git merge` + `git push` locally — branch protection rules may block direct pushes, and complete_session will refuse to mark the session done while the PR is still open on GitHub.',
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
  {
    name: 'github_http_forward',
    description:
      'Forward an HTTP request to the GitHub API. The daemon injects project-scoped authentication, enforces an allowlist of (method, path) pairs, and restricts access to this session\'s repository. Only the agent socket ever sees the token.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method: GET, POST, PATCH' },
        path: { type: 'string', description: 'GitHub API path (e.g., /repos/owner/name/pulls)' },
        body: { type: 'string', description: 'Request body as JSON string (optional)' },
      },
      required: ['method', 'path'],
    },
  },
  {
    name: 'push_branch',
    description:
      'Push a feature branch to the session\'s GitHub repository. First create a bundle in your working directory with `git bundle create ./push-bundle.bundle origin/<base>..<branch>`, then call this tool with the branch name. The daemon verifies the bundle, rejects workflow (.github) changes and protected branches, and pushes from a daemon-owned repository with credentials the agent never sees.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Feature branch to push (e.g. agent/my-fix). Protected branches are rejected.' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'pr_create',
    description:
      'Open a pull request on the session\'s repository targeting the base branch. The daemon rejects pull requests whose base is a protected push-target branch (main/master).',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'object', description: 'Pull request fields: { title, head, base, body }.' },
      },
      required: ['body'],
    },
  },
  {
    name: 'pr_view',
    description: 'Fetch a pull request on the session\'s repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'register_worktree',
    description: 'Register the working directory path for this session so the reaper can clean it up after the session ends.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the session working directory under ~/agent-runs/' },
      },
      required: ['path'],
    },
  },
  {
    name: 'report_outcome',
    description:
      'Report the structured outcome of this task attempt. Preferred over any free-text summary. Call this before the session ends.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', description: 'One of: succeeded | failed | blocked' },
        reason_code: { type: 'string', description: 'Optional closed reason-code enum value' },
        reason: { type: 'string', description: 'Optional free-text reason for humans' },
        blocked: { type: 'object', description: 'When outcome=blocked: { question, needs }' },
        pr_url: { type: 'string', description: 'Optional: the PR URL if you opened a pull request' },
      },
      required: ['outcome'],
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

  /**
   * Resolve the agent socket path for the credential-boundary relays. The
   * daemon wires `AGENT_ROUTER_AGENT_SOCK` into the per-session MCP env (and
   * falls back to the operator socket when isolation is off). The explicit
   * `ctx.agentSocket` wins for tests.
   */
  function resolveAgentSocket(): string {
    return (
      ctx.agentSocket ??
      process.env['AGENT_ROUTER_AGENT_SOCK'] ??
      process.env['AGENT_ROUTER_SOCKET'] ??
      daemonSocket
    );
  }

  /** Resolve the per-session capability token presented to the agent socket. */
  function resolveCapToken(): string {
    return ctx.capToken ?? process.env['AGENT_ROUTER_CAP_TOKEN'] ?? '';
  }

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
        case 'merge_pr': {
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
            op: 'merge_pr',
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
        case 'github_http_forward': {
          const method = toolArgs['method'];
          const path = toolArgs['path'];
          const body = toolArgs['body'];

          if (typeof method !== 'string' || method.length === 0) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or empty "method" argument' }) }],
              isError: true,
            }));
            return;
          }
          if (typeof path !== 'string' || path.length === 0) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or empty "path" argument' }) }],
              isError: true,
            }));
            return;
          }

          // Thin relay to the daemon-side `github_forward` op on the agent
          // socket. The daemon owns the allowlist, repo-scope check, token
          // injection, and size caps — the agent never sees a credential.
          result = await sendToDaemon(resolveAgentSocket(), {
            op: 'github_forward',
            session_id: sessionId,
            cap_token: resolveCapToken(),
            method,
            path,
            body,
          });
          break;
        }
        case 'push_branch': {
          const branch = toolArgs['branch'];
          if (typeof branch !== 'string' || branch.length === 0) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or empty "branch" argument' }) }],
              isError: true,
            }));
            return;
          }
          // Thin relay to the daemon-side `push_branch` op on the agent socket.
          // The agent must have created `./push-bundle.bundle` in its working
          // directory first; the daemon verifies and pushes it.
          result = await sendToDaemon(resolveAgentSocket(), {
            op: 'push_branch',
            session_id: sessionId,
            cap_token: resolveCapToken(),
            branch,
          });
          break;
        }
        case 'pr_create': {
          const body = toolArgs['body'];
          if (body === undefined || body === null || typeof body !== 'object') {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or invalid "body" argument' }) }],
              isError: true,
            }));
            return;
          }
          // Thin relay to the daemon-side `pr_create` op on the agent socket.
          result = await sendToDaemon(resolveAgentSocket(), {
            op: 'pr_create',
            session_id: sessionId,
            cap_token: resolveCapToken(),
            body,
          });
          break;
        }
        case 'pr_view': {
          const prNumber = toolArgs['pr_number'];
          if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or invalid "pr_number" argument' }) }],
              isError: true,
            }));
            return;
          }
          // Thin relay to the daemon-side `pr_view` op on the agent socket.
          result = await sendToDaemon(resolveAgentSocket(), {
            op: 'pr_view',
            session_id: sessionId,
            cap_token: resolveCapToken(),
            pr_number: prNumber,
          });
          break;
        }
        case 'register_worktree': {
          const wtPath = toolArgs['path'];
          if (typeof wtPath !== 'string' || wtPath.length === 0) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or empty "path" argument' }) }],
              isError: true,
            }));
            return;
          }
          result = await sendToDaemon(daemonSocket, {
            op: 'register_worktree',
            session_id: sessionId,
            path: wtPath,
          });
          break;
        }
        case 'report_outcome': {
          const outcome = toolArgs['outcome'];
          if (typeof outcome !== 'string' || outcome.length === 0) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or empty "outcome" argument' }) }],
              isError: true,
            }));
            return;
          }
          // Forward the full argument set, including pr_url (HIGH-5), to the daemon.
          result = await sendToDaemon(daemonSocket, {
            op: 'report_outcome',
            session_id: sessionId,
            outcome,
            reason_code: toolArgs['reason_code'] ?? null,
            reason: toolArgs['reason'] ?? null,
            blocked: toolArgs['blocked'] ?? null,
            pr_url: toolArgs['pr_url'] ?? null,
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

/**
 * Start the MCP server from environment variables (`AGENT_ROUTER_SESSION_ID`,
 * `AGENT_ROUTER_SOCKET`, and — for the credential-boundary relays —
 * `AGENT_ROUTER_AGENT_SOCK` + `AGENT_ROUTER_CAP_TOKEN`). Called by the
 * `agent-router-mcp` bin entry and by the `isMainModule` guard below. Exits the
 * process non-zero if the required env vars are missing or the server errors.
 */
export function runMcpServerFromEnv(): void {
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

  // The agent socket + cap token resolve from env inside createMcpServer at
  // call time (AGENT_ROUTER_AGENT_SOCK / AGENT_ROUTER_CAP_TOKEN).
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

const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith('mcp-server.ts') || process.argv[1].endsWith('mcp-server.js'));

if (isMainModule) {
  runMcpServerFromEnv();
}
