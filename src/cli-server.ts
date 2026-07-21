import * as net from 'node:net';
import * as fs from 'node:fs';
import type { Logger } from './log.js';
import type { SessionManager } from './session-mgr.js';
import { OpenPRsError } from './session-mgr.js';
import type { SessionFiles } from './session-files.js';
import type { Database } from './db.js';
import type { ScheduledTask } from 'node-cron';
import type { TokenStore } from './token-store.js';

export interface CronEntry {
  name: string;
  schedule: string;
  repo: string;
}

export interface CliRequest {
  op:
    | 'new_session'
    | 'list_sessions'
    | 'inject_prompt'
    | 'terminate_session'
    | 'kill_session'
    | 'register_pr'
    | 'merge_pr'
    | 'session_status'
    | 'complete_session'
    | 'cron_list'
    | 'cron_pause'
    | 'cron_resume'
    | 'get_session_project'
    | 'get_token'
    | 'tokens_status';
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
  db?: Database;
  cronTasks?: ScheduledTask[];
  cronEntries?: CronEntry[];
  tokenStore?: TokenStore;
}): CliServer {
  const { socketPath, sessionMgr, sessionFiles, log, db, cronTasks, cronEntries, tokenStore } = deps;

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
      const readRepos = Array.isArray(req['read_repos'])
        ? (req['read_repos'] as unknown[]).filter((r): r is string => typeof r === 'string')
        : undefined;

      // Collision detection: refuse if an active session exists for this repo
      if (repo !== undefined && !force && sessionMgr.hasActiveSessionForRepo(repo)) {
        throw new Error(
          `Active session already exists for repo "${repo}". Use --force to bypass.`,
        );
      }

      const handle = await sessionMgr.createSession(prompt, repo, readRepos);
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
      await sessionMgr.terminateSession(sessionId, 'terminated_cli', 'local');
      return { ok: true };
    },

    async kill_session(req: CliRequest): Promise<Record<string, unknown>> {
      const sessionId = req['session_id'];
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('Missing or empty "session_id" parameter');
      }
      const reason = typeof req['reason'] === 'string' && req['reason'].length > 0
        ? req['reason']
        : 'killed_by_operator';
      await sessionMgr.terminateSession(sessionId, 'killed_by_operator', reason);
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

    async merge_pr(req: CliRequest): Promise<Record<string, unknown>> {
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
      const result = await sessionMgr.mergePR(sessionId, repo, prNumber);
      return { ok: true, sha: result.sha, message: result.message };
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
      try {
        await sessionMgr.completeSession(sessionId, reason);
      } catch (err) {
        if (err instanceof OpenPRsError) {
          // Structured error so the MCP layer can pass the open-PR list back
          // to the agent without losing the per-PR detail.
          return { error: err.message, open_prs: err.openPRs };
        }
        throw err;
      }
      return { ok: true };
    },

    async cron_list(): Promise<Record<string, unknown>> {
      if (!cronEntries || !db) {
        return { error: 'Cron not configured' };
      }
      const states = db.getAllCronStates();
      const stateMap = new Map(states.map((s) => [s.name, s.paused]));
      const entries = cronEntries.map((e) => ({
        name: e.name,
        repo: e.repo,
        schedule: e.schedule,
        paused: stateMap.get(e.name) ?? false,
      }));
      return { entries };
    },

    async cron_pause(req: CliRequest): Promise<Record<string, unknown>> {
      if (!cronEntries || !cronTasks || !db) {
        return { error: 'Cron not configured' };
      }
      const name = req['name'];
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('Missing or empty "name" parameter');
      }
      const idx = cronEntries.findIndex((e) => e.name === name);
      if (idx === -1) {
        const known = cronEntries.map((e) => e.name);
        throw new Error(`Unknown cron name "${name}". Known: ${known.join(', ')}`);
      }
      db.setCronPaused(name, true);
      cronTasks[idx]!.stop();
      return { ok: true };
    },

    async cron_resume(req: CliRequest): Promise<Record<string, unknown>> {
      if (!cronEntries || !cronTasks || !db) {
        return { error: 'Cron not configured' };
      }
      const name = req['name'];
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('Missing or empty "name" parameter');
      }
      const idx = cronEntries.findIndex((e) => e.name === name);
      if (idx === -1) {
        const known = cronEntries.map((e) => e.name);
        throw new Error(`Unknown cron name "${name}". Known: ${known.join(', ')}`);
      }
      db.setCronPaused(name, false);
      cronTasks[idx]!.start();
      return { ok: true };
    },

    async get_session_project(req: CliRequest): Promise<Record<string, unknown>> {
      const sessionId = req['session_id'];
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { error: 'Missing or empty "session_id" parameter' };
      }
      const handle = sessionMgr.getActiveSession(sessionId);
      if (!handle) {
        return { error: `Session not found: ${sessionId}` };
      }
      if (!handle.boundProject || !handle.boundProjectRepos) {
        return { error: `Session "${sessionId}" has no bound project` };
      }
      const meta = sessionFiles.readMeta(sessionId);
      const readRepos = meta.bound_project_read_repos ?? [];
      return {
        project: handle.boundProject,
        repos: handle.boundProjectRepos,
        read_repos: readRepos,
      };
    },

    async get_token(req: CliRequest): Promise<Record<string, unknown>> {
      const project = req['project'];
      if (typeof project !== 'string' || project.length === 0) {
        return { error: 'Missing or empty "project" parameter' };
      }
      if (!tokenStore) {
        return { error: 'Token store not configured' };
      }
      const secret = tokenStore.getToken(project);
      if (!secret) {
        return { error: `No token found for project "${project}"` };
      }
      const projectEntry = tokenStore.getProject(project);
      const expiresAt = projectEntry?.expiresAt
        ? projectEntry.expiresAt.toISOString()
        : null;
      return { token: secret.reveal(), expires_at: expiresAt };
    },

    async tokens_status(req: CliRequest): Promise<Record<string, unknown>> {
      if (!tokenStore) {
        return { error: 'Token store not configured' };
      }
      const check = req['check'] === true;
      const tokenMap = tokenStore.getTokenMap();
      const now = new Date();

      const projects: Array<{
        name: string;
        repoCount: number;
        expiryStatus: string;
        validationResult?: { valid: boolean; error?: string; checked_at: string };
      }> = [];

      for (const [name, entry] of tokenMap.projects) {
        let expiryStatus: string;
        if (entry.expiresAt === undefined) {
          expiryStatus = 'no-expiry-set';
        } else {
          const msUntilExpiry = entry.expiresAt.getTime() - now.getTime();
          const daysUntilExpiry = Math.ceil(msUntilExpiry / (24 * 60 * 60 * 1000));
          if (daysUntilExpiry <= 0) {
            expiryStatus = 'expired';
          } else if (daysUntilExpiry <= 14) {
            expiryStatus = 'expiring-soon';
          } else {
            expiryStatus = 'valid';
          }
        }

        const projectResult: typeof projects[number] = { name, repoCount: entry.repos.length, expiryStatus };

        if (check) {
          const validationResult = await validateTokenLive(entry.token.reveal());
          projectResult.validationResult = {
            ...validationResult,
            checked_at: now.toISOString(),
          };
        }

        projects.push(projectResult);
      }

      return { projects };
    },
  };

  // --- Live token validation helper ---

  async function validateTokenLive(token: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => { controller.abort(); }, 10_000);
      const response = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'agent-router',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.status === 200) {
        return { valid: true };
      }
      if (response.status === 401) {
        return { valid: false, error: '401 Unauthorized' };
      }
      if (response.status === 403) {
        return { valid: false, error: '403 Forbidden' };
      }
      if (response.status === 429) {
        return { valid: false, error: 'rate-limited' };
      }
      return { valid: false, error: `HTTP ${response.status}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: msg };
    }
  }

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
