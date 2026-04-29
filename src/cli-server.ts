import * as net from 'node:net';
import * as fs from 'node:fs';
import type { Logger } from './log.js';
import type { SessionManager } from './session-mgr.js';
import type { SessionFiles } from './session-files.js';

export interface CliRequest {
  op: 'new_session' | 'list_sessions' | 'inject_prompt' | 'terminate_session' | 'register_pr' | 'session_status' | 'complete_session';
  [key: string]: unknown;
}

export interface CliServer {
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

type OpHandler = (req: CliRequest) => Promise<Record<string, unknown>>;

export function createCliServer(deps: {
  socketPath: string;
  sessionMgr: SessionManager;
  sessionFiles: SessionFiles;
  log: Logger;
}): CliServer {
  const { socketPath, sessionMgr, sessionFiles, log } = deps;

  let server: net.Server | null = null;
  const activeConnections = new Set<net.Socket>();

  // --- Op handlers ---

  const handlers: Record<string, OpHandler> = {
    async list_sessions(): Promise<Record<string, unknown>> {
      const sessions = sessionFiles.listSessions();
      return { sessions };
    },

    async new_session(req: CliRequest): Promise<Record<string, unknown>> {
      const prompt = req['prompt'];
      if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new Error('Missing or empty "prompt" parameter');
      }
      const repo = typeof req['repo'] === 'string' ? req['repo'] : undefined;
      const force = req['force'] === true;

      // Collision detection: refuse if an active session exists for this repo
      if (repo !== undefined && !force && sessionMgr.hasActiveSessionForRepo(repo)) {
        throw new Error(
          `Active session already exists for repo "${repo}". Use --force to bypass.`,
        );
      }

      const handle = await sessionMgr.createSession(prompt, repo);
      return {
        session_id: handle.sessionId,
        stream_path: handle.paths.stream,
        prompts_path: handle.paths.prompts,
      };
    },

    async inject_prompt(req: CliRequest): Promise<Record<string, unknown>> {
      const sessionId = req['session_id'];
      const prompt = req['prompt'];
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('Missing or empty "session_id" parameter');
      }
      if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new Error('Missing or empty "prompt" parameter');
      }
      const source = typeof req['source'] === 'string' ? req['source'] : 'cli';
      await sessionMgr.injectPrompt(sessionId, prompt, source as 'cli');
      return { ok: true };
    },

    async terminate_session(req: CliRequest): Promise<Record<string, unknown>> {
      const sessionId = req['session_id'];
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('Missing or empty "session_id" parameter');
      }
      await sessionMgr.terminateSession(sessionId);
      return { ok: true };
    },

    async register_pr(req: CliRequest): Promise<Record<string, unknown>> {
      const sessionId = req['session_id'];
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('Missing or empty "session_id" parameter');
      }
      const repo = req['repo'];
      if (typeof repo !== 'string' || repo.length === 0) {
        throw new Error('Missing or empty "repo" parameter');
      }
      const prNumber = req['pr_number'];
      if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) {
        throw new Error('Missing or invalid "pr_number" parameter');
      }
      await sessionMgr.registerPR(sessionId, repo, prNumber);
      return { ok: true };
    },

    async session_status(req: CliRequest): Promise<Record<string, unknown>> {
      const sessionId = req['session_id'];
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('Missing or empty "session_id" parameter');
      }
      const meta = sessionFiles.readMeta(sessionId);
      return {
        original_prompt: meta.original_prompt,
        prs: meta.prs,
        status: meta.status,
      };
    },

    async complete_session(req: CliRequest): Promise<Record<string, unknown>> {
      const sessionId = req['session_id'];
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('Missing or empty "session_id" parameter');
      }
      const reason = req['reason'];
      if (typeof reason !== 'string' || reason.length === 0) {
        throw new Error('Missing or empty "reason" parameter');
      }
      sessionMgr.completeSession(sessionId, reason);
      return { ok: true };
    },
  };

  // --- Connection handler ---

  function handleConnection(socket: net.Socket): void {
    activeConnections.add(socket);
    let buffer = '';

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Process all complete lines in the buffer
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (line.trim().length > 0) {
          processLine(line, socket);
        }

        newlineIdx = buffer.indexOf('\n');
      }
    });

    socket.on('close', () => {
      activeConnections.delete(socket);
    });

    socket.on('error', (err: Error) => {
      log.warn('CLI socket connection error', { error: err.message });
      activeConnections.delete(socket);
    });
  }

  function processLine(line: string, socket: net.Socket): void {
    // Parse and dispatch asynchronously, write response back
    void (async () => {
      let response: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          response = { error: 'Request must be a JSON object' };
        } else {
          const req = parsed as CliRequest;
          const op = req['op'];
          if (typeof op !== 'string') {
            response = { error: 'Missing "op" field' };
          } else {
            const handler = handlers[op];
            if (!handler) {
              response = { error: `Unknown op: ${op}` };
            } else {
              response = await handler(req);
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof SyntaxError
          ? 'Invalid JSON'
          : err instanceof Error ? err.message : String(err);
        response = { error: msg };
      }

      try {
        if (!socket.destroyed) {
          socket.write(JSON.stringify(response) + '\n');
        }
      } catch {
        // Socket may have been closed; best effort
      }
    })();
  }

  return {
    async start(): Promise<void> {
      // Remove stale socket file if it exists
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // File doesn't exist — that's fine
      }

      return new Promise<void>((resolve, reject) => {
        server = net.createServer(handleConnection);

        server.on('error', (err: Error) => {
          log.error('CLI server error', { error: err.message });
          reject(err);
        });

        server.listen(socketPath, () => {
          log.info('CLI server listening', { socketPath });
          resolve();
        });
      });
    },

    async shutdown(): Promise<void> {
      if (!server) return;

      // Close the server to stop accepting new connections
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });

      // Destroy all active connections
      for (const socket of activeConnections) {
        socket.destroy();
      }
      activeConnections.clear();

      // Clean up socket file
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Already removed or doesn't exist
      }

      server = null;
      log.info('CLI server shut down');
    },
  };
}
