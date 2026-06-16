/**
 * CLI client binary for Agent Router.
 *
 * Entrypoint is `bin/agent-router.mjs`, which boots tsx and then imports
 * this file. Do not invoke this `.ts` file directly — `node --import tsx/esm`
 * resolves the tsx specifier relative to cwd, which breaks the CLI when
 * invoked from any directory outside the project root.
 *
 * Subcommands:
 *   prompt --new [--quiet] [--file <path>]   Create a new session
 *   prompt --session-id <id>                 Inject prompt into existing session
 *   ls [--all] [--full] [--limit N]                   List sessions
 *   tail <session_id> [--raw] [--prompts]    Tail session output
 *   terminate <session_id>                   Terminate a session
 *
 * Connects to the daemon's Unix domain socket at <AGENT_ROUTER_HOME>/sock.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { selectVisibleSessions, DEFAULT_LS_LIMIT } from '../src/ls-pagination.js';
import { resolveSessionId } from '../src/session-id.js';
import { prettyPrint, type StreamEntryLike } from '../src/pretty-print.js';

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

// ---------------------------------------------------------------------------
// Socket path resolution
// ---------------------------------------------------------------------------

function resolveSocketPath(): string {
  const home = process.env['AGENT_ROUTER_HOME'] ?? path.join(os.homedir(), '.agent-router');
  return path.join(home, 'sock');
}

function resolveSessionsDir(): string {
  const home = process.env['AGENT_ROUTER_HOME'] ?? path.join(os.homedir(), '.agent-router');
  return path.join(home, 'sessions');
}

/**
 * Resolve a session-id prefix to a full session ID using the sessions directory.
 * Exits the process with an error if no match or ambiguous.
 */
function resolveSessionPrefix(prefix: string): string {
  const sessionsDir = resolveSessionsDir();
  let candidates: string[] = [];
  try {
    candidates = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // Directory doesn't exist — no candidates
  }

  const result = resolveSessionId(prefix, candidates);
  if (result.kind === 'match') return result.sessionId;

  if (result.kind === 'no_match') {
    process.stderr.write(`Error: no session matching prefix "${prefix}"\n`);
    process.exit(1);
  }

  // ambiguous
  process.stderr.write(`Error: ambiguous prefix "${prefix}" matches ${result.candidates.length} sessions:\n`);
  for (const c of result.candidates) {
    process.stderr.write(`  ${c}\n`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Daemon IPC — send a JSON message over Unix socket, receive JSON response
// ---------------------------------------------------------------------------

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
        } catch (e) {
          reject(new Error(`Invalid JSON response from daemon: ${line}`));
        }
      }
    });

    socket.on('error', (err: Error) => {
      reject(new Error(`Cannot connect to daemon socket at ${socketPath}: ${err.message}`));
    });

    socket.on('close', () => {
      if (buffer.trim()) {
        try {
          resolve(JSON.parse(buffer.trim()) as Record<string, unknown>);
        } catch {
          reject(new Error('Daemon closed connection without valid response'));
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tail a log file with follow semantics
// ---------------------------------------------------------------------------

function tailFile(
  filePath: string,
  opts: { raw: boolean },
): { stop: () => void } {
  let position = 0;
  let partialLine = '';
  let watcher: fs.FSWatcher | null = null;
  let stopped = false;

  function readNewContent(): void {
    if (stopped) return;

    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch {
      return; // File may not exist yet
    }

    try {
      const stat = fs.fstatSync(fd);
      if (stat.size <= position) return;

      const buf = Buffer.alloc(stat.size - position);
      fs.readSync(fd, buf, 0, buf.length, position);
      position = stat.size;

      const text = partialLine + buf.toString('utf-8');
      const lines = text.split('\n');

      // Last element may be a partial line
      partialLine = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim().length === 0) continue;

        if (opts.raw) {
          process.stdout.write(line + '\n');
        } else {
          try {
            const entry = JSON.parse(line) as StreamEntryLike;
            process.stdout.write(prettyPrint(entry) + '\n');
          } catch {
            // Not valid JSON — output as-is
            process.stdout.write(line + '\n');
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  // Initial read
  readNewContent();

  // Watch for changes
  try {
    watcher = fs.watch(filePath, () => {
      readNewContent();
    });
  } catch {
    // File may not exist yet — poll instead
  }

  // Also poll periodically as a fallback (fs.watch can miss events)
  const pollInterval = setInterval(() => {
    readNewContent();
  }, 500);

  return {
    stop(): void {
      stopped = true;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      clearInterval(pollInterval);
    },
  };
}

// ---------------------------------------------------------------------------
// Subcommand: prompt
// ---------------------------------------------------------------------------

async function cmdPrompt(args: string[]): Promise<void> {
  const socketPath = resolveSocketPath();

  let isNew = false;
  let quiet = false;
  let force = false;
  let sessionId: string | undefined;
  let filePath: string | undefined;
  let repo: string | undefined;

  // Parse flags
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--new') {
      isNew = true;
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--session-id') {
      sessionId = args[++i];
    } else if (arg === '--file') {
      filePath = args[++i];
    } else if (arg === '--repo') {
      repo = args[++i];
    }
  }

  if (!isNew && sessionId === undefined) {
    process.stderr.write('Usage: agent-router prompt --new [--quiet] [--force] [--repo <owner/name>] [--file <path>]\n');
    process.stderr.write('       agent-router prompt --session-id <id>\n');
    process.exit(1);
  }

  // Read prompt text
  let promptText: string;
  if (filePath !== undefined) {
    promptText = fs.readFileSync(filePath, 'utf-8').trim();
  } else if (!process.stdin.isTTY) {
    // Read from stdin
    promptText = await readStdin();
  } else {
    process.stderr.write('Error: prompt text must be provided via stdin or --file\n');
    process.exit(1);
  }

  if (promptText.length === 0) {
    process.stderr.write('Error: prompt text is empty\n');
    process.exit(1);
  }

  if (isNew) {
    // Create new session
    const msg: Record<string, unknown> = { op: 'new_session', prompt: promptText };
    if (repo !== undefined) msg['repo'] = repo;
    if (force) msg['force'] = true;
    const result = await sendToDaemon(socketPath, msg);

    if (result['error'] !== undefined) {
      process.stderr.write(`Error: ${result['error'] as string}\n`);
      process.exit(1);
    }

    const sid = result['session_id'] as string;
    const streamPath = result['stream_path'] as string;

    if (quiet) {
      // Print session_id and exit
      process.stdout.write(sid + '\n');
      return;
    }

    // Print session_id then tail
    process.stderr.write(`Session: ${sid}\n`);
    const tailer = tailFile(streamPath, { raw: false });

    // Handle SIGINT — stop tailing, exit 0
    process.on('SIGINT', () => {
      tailer.stop();
      process.exit(0);
    });

    // Keep process alive while tailing
    await new Promise<void>(() => {
      // Never resolves — we exit via SIGINT or session end
    });
  } else if (sessionId !== undefined) {
    // Inject prompt into existing session
    const result = await sendToDaemon(socketPath, {
      op: 'inject_prompt',
      session_id: sessionId,
      prompt: promptText,
    });

    if (result['error'] !== undefined) {
      process.stderr.write(`Error: ${result['error'] as string}\n`);
      process.exit(1);
    }

    process.stderr.write('Prompt injected.\n');
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => chunks.push(line));
    rl.on('close', () => resolve(chunks.join('\n').trim()));
  });
}

// ---------------------------------------------------------------------------
// Subcommand: ls
// ---------------------------------------------------------------------------

interface SessionMetaLike {
  session_id: string;
  status: string;
  created_at: number;
  prs: Array<{ repo: string; pr_number: number }>;
  original_prompt: string;
}

function formatAge(createdAt: number): string {
  const diffSec = Math.floor(Date.now() / 1000) - createdAt;
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

async function cmdLs(args: string[]): Promise<void> {
  let all = false;
  let full = false;
  let limit = DEFAULT_LS_LIMIT;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      all = true;
    } else if (arg === '--full') {
      full = true;
    } else if (arg === '--limit') {
      const val = args[++i];
      const parsed = Number(val);
      if (!Number.isFinite(parsed) || parsed < 0) {
        process.stderr.write('Error: --limit must be a non-negative integer\n');
        process.exit(1);
      }
      limit = Math.floor(parsed);
    }
  }

  const socketPath = resolveSocketPath();
  const result = await sendToDaemon(socketPath, { op: 'list_sessions' });

  if (result['error'] !== undefined) {
    process.stderr.write(`Error: ${result['error'] as string}\n`);
    process.exit(1);
  }

  const sessions = result['sessions'] as SessionMetaLike[];
  if (sessions.length === 0) {
    process.stdout.write('No sessions.\n');
    return;
  }

  const visible = selectVisibleSessions(sessions, { all, limit });

  // Table header
  const idWidth = full ? 36 : 10;
  const header = padRow('ID', 'Status', 'Age', 'PRs', 'Prompt', idWidth);
  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(header.length) + '\n');

  for (const s of visible) {
    const id = full ? s.session_id : s.session_id.slice(0, 8);
    const status = s.status;
    const age = formatAge(s.created_at);
    const prs = s.prs.length > 0
      ? s.prs.map((p) => `${p.repo}#${p.pr_number}`).join(', ')
      : '-';
    const prompt = truncate(s.original_prompt.replace(/\n/g, ' '), 40);
    process.stdout.write(padRow(id, status, age, prs, prompt, idWidth) + '\n');
  }

  const hidden = sessions.length - visible.length;
  if (hidden > 0) {
    process.stdout.write(`${GRAY}(${hidden} more sessions hidden — use --all to show all)${RESET}\n`);
  }
}

function padRow(id: string, status: string, age: string, prs: string, prompt: string, idWidth?: number): string {
  const w = idWidth ?? 10;
  return `${id.padEnd(w)} ${status.padEnd(12)} ${age.padEnd(6)} ${prs.padEnd(20)} ${prompt}`;
}

// ---------------------------------------------------------------------------
// Subcommand: tail
// ---------------------------------------------------------------------------

async function cmdTail(args: string[]): Promise<void> {
  let sessionPrefix: string | undefined;
  let raw = false;
  let prompts = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--raw') {
      raw = true;
    } else if (arg === '--prompts') {
      prompts = true;
    } else if (sessionPrefix === undefined && !arg?.startsWith('--')) {
      sessionPrefix = arg;
    }
  }

  if (sessionPrefix === undefined) {
    process.stderr.write('Usage: agent-router tail <session_id> [--raw] [--prompts]\n');
    process.exit(1);
  }

  const sessionId = resolveSessionPrefix(sessionPrefix);
  const sessionsDir = resolveSessionsDir();
  const sessionDir = path.join(sessionsDir, sessionId);

  if (!fs.existsSync(sessionDir)) {
    process.stderr.write(`Error: session directory not found: ${sessionDir}\n`);
    process.exit(1);
  }

  const logFile = prompts
    ? path.join(sessionDir, 'prompts.log')
    : path.join(sessionDir, 'stream.log');

  const tailer = tailFile(logFile, { raw });

  // Handle SIGINT — stop tailing, exit 0
  process.on('SIGINT', () => {
    tailer.stop();
    process.exit(0);
  });

  // Keep process alive
  await new Promise<void>(() => {
    // Never resolves — exit via SIGINT
  });
}

// ---------------------------------------------------------------------------
// Subcommand: terminate
// ---------------------------------------------------------------------------

async function cmdTerminate(args: string[]): Promise<void> {
  const prefix = args[0];
  if (prefix === undefined || prefix.startsWith('--')) {
    process.stderr.write('Usage: agent-router terminate <session_id>\n');
    process.exit(1);
  }

  const sessionId = resolveSessionPrefix(prefix);
  const socketPath = resolveSocketPath();
  const result = await sendToDaemon(socketPath, {
    op: 'terminate_session',
    session_id: sessionId,
  });

  if (result['error'] !== undefined) {
    process.stderr.write(`Error: ${result['error'] as string}\n`);
    process.exit(1);
  }

  process.stderr.write('Session terminated.\n');
}

// ---------------------------------------------------------------------------
// Subcommand: kill
// ---------------------------------------------------------------------------

async function cmdKill(args: string[]): Promise<void> {
  let sessionPrefix: string | undefined;
  let reason: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--reason') {
      reason = args[++i];
    } else if (sessionPrefix === undefined && !arg?.startsWith('--')) {
      sessionPrefix = arg;
    }
  }

  if (sessionPrefix === undefined) {
    process.stderr.write('Usage: agent-router kill <session_id> [--reason <reason>]\n');
    process.exit(1);
  }

  const sessionId = resolveSessionPrefix(sessionPrefix);
  const socketPath = resolveSocketPath();
  const msg: Record<string, unknown> = { op: 'kill_session', session_id: sessionId };
  if (reason !== undefined) msg['reason'] = reason;

  const result = await sendToDaemon(socketPath, msg);

  if (result['error'] !== undefined) {
    process.stderr.write(`Error: ${result['error'] as string}\n`);
    process.exit(1);
  }

  process.stderr.write(`Session killed (reason: ${reason ?? 'killed_by_operator'}).\n`);
}

// ---------------------------------------------------------------------------
// Subcommand: complete-session
// ---------------------------------------------------------------------------

async function cmdCompleteSession(args: string[]): Promise<void> {
  let sessionPrefix: string | undefined;
  let reason: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session-id') {
      sessionPrefix = args[++i];
    } else if (arg === '--reason') {
      reason = args[++i];
    } else if (sessionPrefix === undefined && !arg?.startsWith('--')) {
      sessionPrefix = arg;
    }
  }

  if (sessionPrefix === undefined) {
    process.stderr.write('Usage: agent-router complete-session --session-id <id> --reason <reason>\n');
    process.exit(1);
  }
  if (reason === undefined || reason.length === 0) {
    process.stderr.write('Error: --reason is required\n');
    process.exit(1);
  }

  const sessionId = resolveSessionPrefix(sessionPrefix);
  const socketPath = resolveSocketPath();
  const result = await sendToDaemon(socketPath, {
    op: 'complete_session',
    session_id: sessionId,
    reason,
  });

  if (result['error'] !== undefined) {
    process.stderr.write(`Error: ${result['error'] as string}\n`);
    process.exit(1);
  }

  process.stderr.write(`Session completed (reason: ${reason}).\n`);
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

function printUsage(): void {
  process.stderr.write(`Usage: agent-router <command> [options]

Commands:
  prompt --new [--quiet] [--force] [--repo <owner/name>] [--file <path>]
                                           Create a new session
  prompt --session-id <id>                 Inject prompt into existing session
  ls [--all] [--full] [--limit N]          List sessions (default: 20 rows)
  tail <session_id> [--raw] [--prompts]    Tail session output
  terminate <session_id>                   Terminate a session
  kill <session_id> [--reason <reason>]    Kill a session (default: killed_by_operator)
  complete-session --session-id <id> --reason <reason>
                                           Signal session completion
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === undefined || command === '--help' || command === '-h') {
    printUsage();
    process.exit(command === undefined ? 1 : 0);
  }

  const subArgs = args.slice(1);

  switch (command) {
    case 'prompt':
      await cmdPrompt(subArgs);
      break;
    case 'ls':
      await cmdLs(subArgs);
      break;
    case 'tail':
      await cmdTail(subArgs);
      break;
    case 'terminate':
      await cmdTerminate(subArgs);
      break;
    case 'kill':
      await cmdKill(subArgs);
      break;
    case 'complete-session':
      await cmdCompleteSession(subArgs);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
});
