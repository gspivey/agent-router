import * as net from 'node:net';
import { createInterface } from 'node:readline';
import {
  validateMethod,
  validatePathPrefix,
  validateBodySize,
  validateRepoAuthorization,
} from './credential-validators.js';

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
    description: 'Forward an HTTP request to the GitHub API with project-scoped authentication.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, DELETE' },
        path: { type: 'string', description: 'GitHub API path (e.g., /repos/owner/name/pulls)' },
        body: { type: 'string', description: 'Request body as JSON string (optional)' },
        repo: { type: 'string', description: 'Repository in owner/repo format' },
      },
      required: ['method', 'path', 'repo'],
    },
  },
  {
    name: 'git_credential',
    description: 'Get git HTTPS credentials for a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
      },
      required: ['repo'],
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

  // Cached session project info — populated on first tool call that needs it.
  // Fetched once from the daemon and reused for the session's lifetime.
  let cachedProject: { project: string; repos: string[]; readRepos: string[] } | null = null;
  let projectFetchFailed: string | null = null;

  async function getSessionProject(): Promise<{ project: string; repos: string[]; readRepos: string[] }> {
    if (cachedProject) return cachedProject;
    if (projectFetchFailed) throw new Error(projectFetchFailed);

    const response = await sendToDaemon(daemonSocket, {
      op: 'get_session_project',
      session_id: sessionId,
    });

    if (response['error']) {
      const errMsg = `Failed to get session project: ${String(response['error'])}`;
      projectFetchFailed = errMsg;
      throw new Error(errMsg);
    }

    cachedProject = {
      project: response['project'] as string,
      repos: response['repos'] as string[],
      readRepos: response['read_repos'] as string[],
    };
    return cachedProject;
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
          const repo = toolArgs['repo'];

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
          if (typeof repo !== 'string' || repo.length === 0) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or empty "repo" argument' }) }],
              isError: true,
            }));
            return;
          }

          const bodyStr = typeof body === 'string' ? body : undefined;

          // Validate method
          const methodErr = validateMethod(method);
          if (methodErr) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: methodErr.message, code: methodErr.code }) }],
              isError: true,
            }));
            return;
          }

          // Validate path prefix
          const pathErr = validatePathPrefix(path);
          if (pathErr) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: pathErr.message, code: pathErr.code }) }],
              isError: true,
            }));
            return;
          }

          // Validate body size
          const bodyErr = validateBodySize(bodyStr);
          if (bodyErr) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: bodyErr.message, code: bodyErr.code }) }],
              isError: true,
            }));
            return;
          }

          // Get session project for authorization
          const sessionProject = await getSessionProject();

          // Validate repo authorization
          const authErr = validateRepoAuthorization(method, repo, {
            boundProjectRepos: sessionProject.repos,
            readRepos: sessionProject.readRepos,
          });
          if (authErr) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: authErr.message, code: authErr.code }) }],
              isError: true,
            }));
            return;
          }

          // Fetch token (not cached — fetched per call)
          const tokenResp = await sendToDaemon(daemonSocket, {
            op: 'get_token',
            project: sessionProject.project,
          });
          if (tokenResp['error']) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: `Token retrieval failed: ${String(tokenResp['error'])}` }) }],
              isError: true,
            }));
            return;
          }

          // Skeleton: full HTTP forwarding not yet implemented
          result = { error: 'github_http_forward: HTTP forwarding not yet implemented (pending item 38)' };
          break;
        }
        case 'git_credential': {
          const repo = toolArgs['repo'];

          if (typeof repo !== 'string' || repo.length === 0) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing or empty "repo" argument' }) }],
              isError: true,
            }));
            return;
          }

          // Get session project for authorization
          const sessionProject = await getSessionProject();

          // git_credential requires the repo to be in the Bound_Project repos (Req 6.2)
          if (!sessionProject.repos.includes(repo)) {
            const authErr = {
              code: 'repo_unauthorized',
              message: `Repository "${repo}" is not in the bound project's repo list. Git credentials are only available for bound project repos.`,
            };
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: authErr.message, code: authErr.code }) }],
              isError: true,
            }));
            return;
          }

          // Fetch token (not cached — fetched per call)
          const tokenResp = await sendToDaemon(daemonSocket, {
            op: 'get_token',
            project: sessionProject.project,
          });
          if (tokenResp['error']) {
            writeResponse(makeSuccessResponse(req.id, {
              content: [{ type: 'text', text: JSON.stringify({ error: `Token retrieval failed: ${String(tokenResp['error'])}` }) }],
              isError: true,
            }));
            return;
          }

          // Skeleton: full credential delivery not yet implemented
          result = { error: 'git_credential: credential delivery not yet implemented (pending item 39)' };
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
