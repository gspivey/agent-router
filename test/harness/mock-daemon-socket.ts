/**
 * Mock daemon socket for credential tool testing.
 *
 * Simulates the `get_session_project` and `get_token` IPC operations that the
 * MCP credential tools call back into the daemon to resolve project credentials.
 * Used in Tier 2 tests for credential tool forwarding (items 38/39).
 *
 * Usage:
 *   const mock = new MockDaemonSocket();
 *   await mock.start();
 *   mock.setSessionProject(sessionId, { project: 'myproject', repos: ['org/repo'], read_repos: [] });
 *   mock.setProjectToken('myproject', 'ghp_token123', '2027-01-01T00:00:00Z');
 *   // ... run tests against mock.socketPath() ...
 *   await mock.stop();
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SessionProjectInfo {
  project: string;
  repos: string[];
  read_repos: string[];
}

export interface ProjectTokenInfo {
  token: string;
  expires_at?: string;
}

export interface MockDaemonSocket {
  start(): Promise<void>;
  stop(): Promise<void>;
  socketPath(): string;
  /** Configure the project info returned for a given session_id. */
  setSessionProject(sessionId: string, info: SessionProjectInfo | null): void;
  /** Configure the token returned for a given project name. */
  setProjectToken(project: string, token: string, expiresAt?: string): void;
  /** Remove token configuration for a project. */
  clearProjectToken(project: string): void;
  /** Returns all IPC requests received since last reset. */
  getRequests(): IpcRequest[];
  /** Clear recorded requests. */
  clearRequests(): void;
}

export interface IpcRequest {
  op: string;
  [key: string]: unknown;
}

/**
 * A newline-delimited JSON IPC server that handles:
 * - `get_session_project { session_id }` → `{ project, repos, read_repos }` or `{ error }`
 * - `get_token { project }` → `{ token, expires_at? }` or `{ error }`
 *
 * Any other `op` returns `{ error: "unknown_op" }`.
 */
export function createMockDaemonSocket(): MockDaemonSocket {
  let server: net.Server | null = null;
  let tmpDir = '';
  let sockPath = '';
  const activeConns = new Set<net.Socket>();

  const sessionProjects = new Map<string, SessionProjectInfo | null>();
  const projectTokens = new Map<string, ProjectTokenInfo>();
  const requests: IpcRequest[] = [];

  async function start(): Promise<void> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-daemon-'));
    sockPath = path.join(tmpDir, 'daemon.sock');

    await new Promise<void>((resolve, reject) => {
      server = net.createServer((socket) => {
        activeConns.add(socket);
        socket.on('close', () => activeConns.delete(socket));

        let buf = '';
        socket.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let req: IpcRequest;
            try {
              req = JSON.parse(line) as IpcRequest;
            } catch {
              socket.write(JSON.stringify({ error: 'invalid_json' }) + '\n');
              continue;
            }
            requests.push(req);
            const response = handleRequest(req);
            socket.write(JSON.stringify(response) + '\n');
          }
        });

        socket.on('error', () => {
          /* ignore client disconnect errors */
        });
      });

      server.listen(sockPath, () => resolve());
      server.on('error', reject);
    });
  }

  async function stop(): Promise<void> {
    for (const conn of activeConns) {
      conn.destroy();
    }
    activeConns.clear();

    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((err) => (err ? reject(err) : resolve()));
    });

    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
      sockPath = '';
    }
  }

  function handleRequest(req: IpcRequest): Record<string, unknown> {
    const { op } = req;

    if (op === 'get_session_project') {
      const sessionId = req['session_id'] as string | undefined;
      if (!sessionId) return { error: 'missing_session_id' };

      if (!sessionProjects.has(sessionId)) return { error: 'session_not_found' };
      const info = sessionProjects.get(sessionId);
      if (!info) return { error: 'no_project_bound' };

      return {
        project: info.project,
        repos: info.repos,
        read_repos: info.read_repos,
      };
    }

    if (op === 'get_token') {
      const project = req['project'] as string | undefined;
      if (!project) return { error: 'missing_project' };

      if (!projectTokens.has(project)) return { error: 'project_not_found' };
      const info = projectTokens.get(project)!;

      const result: Record<string, unknown> = { token: info.token };
      if (info.expires_at !== undefined) {
        result['expires_at'] = info.expires_at;
      }
      return result;
    }

    return { error: 'unknown_op' };
  }

  return {
    async start() {
      await start();
    },
    async stop() {
      await stop();
    },
    socketPath() {
      return sockPath;
    },
    setSessionProject(sessionId: string, info: SessionProjectInfo | null) {
      sessionProjects.set(sessionId, info);
    },
    setProjectToken(project: string, token: string, expiresAt?: string) {
      const info: ProjectTokenInfo = { token };
      if (expiresAt !== undefined) {
        info.expires_at = expiresAt;
      }
      projectTokens.set(project, info);
    },
    clearProjectToken(project: string) {
      projectTokens.delete(project);
    },
    getRequests() {
      return [...requests];
    },
    clearRequests() {
      requests.length = 0;
    },
  };
}
