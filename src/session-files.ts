import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Logger } from './log.js';

export interface StreamEntry {
  ts: string;
  source: 'router' | 'agent';
  type: string;
  [key: string]: unknown;
}

export interface SessionMeta {
  session_id: string;
  original_prompt: string;
  status: 'active' | 'completed' | 'abandoned' | 'failed';
  created_at: number;
  completed_at: number | null;
  termination_reason?: 'timeout_inactivity' | 'timeout_max_lifetime' | 'completed' | 'failed' | 'terminated' | 'shutdown' | 'merged';
  prs: Array<{ repo: string; pr_number: number; registered_at: number }>;
}

export type PromptSource = 'cli' | 'webhook' | 'cron' | 'mcp';

export interface PromptEntry {
  ts: string;
  source: PromptSource;
  prompt: string;
}

export interface SessionPaths {
  dir: string;
  meta: string;
  stream: string;
  prompts: string;
}

export interface SessionFiles {
  createSession(sessionId: string, originalPrompt: string): SessionPaths;
  appendStream(sessionId: string, entry: StreamEntry): void;
  appendPrompt(sessionId: string, source: PromptSource, prompt: string): void;
  updateMeta(sessionId: string, patch: Partial<SessionMeta>): void;
  readMeta(sessionId: string): SessionMeta;
  listSessions(): SessionMeta[];
  sessionExists(sessionId: string): boolean;
}

const VALID_STATUSES = new Set(['active', 'completed', 'abandoned', 'failed']);
const TERMINAL_STATUSES = new Set(['completed', 'abandoned', 'failed']);

function isValidStatus(s: string): s is SessionMeta['status'] {
  return VALID_STATUSES.has(s);
}

function isTerminalStatus(s: string): boolean {
  return TERMINAL_STATUSES.has(s);
}

/**
 * Strip embedded newlines from all string values in an object.
 * This ensures each NDJSON line is truly a single line.
 */
function stripNewlines(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = value.replace(/\r?\n/g, ' ');
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Atomically write content to a file using temp-file-plus-rename.
 * Writes to a temp file in the same directory, fsyncs, then renames.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * Append a line to a file with fsync for durability.
 */
function appendLineSync(filePath: string, line: string): void {
  const fd = fs.openSync(filePath, 'a');
  try {
    fs.writeSync(fd, line + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sessionPaths(rootDir: string, sessionId: string): SessionPaths {
  const dir = path.join(rootDir, 'sessions', sessionId);
  return {
    dir,
    meta: path.join(dir, 'meta.json'),
    stream: path.join(dir, 'stream.log'),
    prompts: path.join(dir, 'prompts.log'),
  };
}

export function createSessionFiles(rootDir: string, log?: Logger): SessionFiles {
  // Ensure root directory structure exists
  const sessionsDir = path.join(rootDir, 'sessions');
  const daemonLogPath = path.join(rootDir, 'daemon.log');

  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  if (!fs.existsSync(daemonLogPath)) {
    fs.writeFileSync(daemonLogPath, '');
  }

  return {
    createSession(sessionId: string, originalPrompt: string): SessionPaths {
      const paths = sessionPaths(rootDir, sessionId);

      try {
        fs.mkdirSync(paths.dir, { recursive: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.error('Failed to create session directory', { sessionId, error: msg });
        throw new Error(`Failed to create session directory: ${msg}`);
      }

      const meta: SessionMeta = {
        session_id: sessionId,
        original_prompt: originalPrompt,
        status: 'active',
        created_at: Math.floor(Date.now() / 1000),
        completed_at: null,
        prs: [],
      };

      try {
        // Write meta.json atomically
        atomicWriteFileSync(paths.meta, JSON.stringify(meta, null, 2) + '\n');

        // Create empty stream.log and prompts.log
        fs.writeFileSync(paths.stream, '');
        fs.writeFileSync(paths.prompts, '');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.error('Failed to create session files', { sessionId, error: msg });
        throw new Error(`Failed to create session files: ${msg}`);
      }

      return paths;
    },

    appendStream(sessionId: string, entry: StreamEntry): void {
      const paths = sessionPaths(rootDir, sessionId);
      const sanitized = stripNewlines(entry as Record<string, unknown>);
      const line = JSON.stringify(sanitized);
      appendLineSync(paths.stream, line);
    },

    appendPrompt(sessionId: string, source: PromptSource, prompt: string): void {
      const paths = sessionPaths(rootDir, sessionId);
      const entry: PromptEntry = {
        ts: new Date().toISOString(),
        source,
        prompt: prompt.replace(/\r?\n/g, ' '),
      };
      const line = JSON.stringify(entry);
      appendLineSync(paths.prompts, line);
    },

    updateMeta(sessionId: string, patch: Partial<SessionMeta>): void {
      const paths = sessionPaths(rootDir, sessionId);

      // Read current meta
      let raw: string;
      try {
        raw = fs.readFileSync(paths.meta, 'utf-8');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read meta.json for session ${sessionId}: ${msg}`);
      }

      const current = JSON.parse(raw) as SessionMeta;

      // Refuse to modify non-active sessions
      if (current.status !== 'active') {
        throw new Error(
          `Cannot modify session ${sessionId}: status is '${current.status}', only 'active' sessions can be modified`
        );
      }

      // Validate status transition if status is being changed
      if (patch.status !== undefined && patch.status !== 'active') {
        if (!isTerminalStatus(patch.status)) {
          throw new Error(
            `Invalid status transition for session ${sessionId}: 'active' → '${patch.status}'`
          );
        }
      }

      const updated: SessionMeta = { ...current, ...patch };

      // Atomic write
      atomicWriteFileSync(paths.meta, JSON.stringify(updated, null, 2) + '\n');
    },

    readMeta(sessionId: string): SessionMeta {
      const paths = sessionPaths(rootDir, sessionId);
      const raw = fs.readFileSync(paths.meta, 'utf-8');
      return JSON.parse(raw) as SessionMeta;
    },

    listSessions(): SessionMeta[] {
      const sessionsDir = path.join(rootDir, 'sessions');

      if (!fs.existsSync(sessionsDir)) {
        return [];
      }

      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      const metas: SessionMeta[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const metaPath = path.join(sessionsDir, entry.name, 'meta.json');
        try {
          const raw = fs.readFileSync(metaPath, 'utf-8');
          metas.push(JSON.parse(raw) as SessionMeta);
        } catch {
          // Skip directories without valid meta.json
        }
      }

      // Sort by created_at descending
      metas.sort((a, b) => b.created_at - a.created_at);
      return metas;
    },

    sessionExists(sessionId: string): boolean {
      const paths = sessionPaths(rootDir, sessionId);
      return fs.existsSync(paths.dir);
    },
  };
}
