import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { SessionFiles } from './session-files.js';
import type { Logger } from './log.js';

// --- Pure helper functions (exported for testability) ---

/**
 * Split a chunk into complete lines and a leftover residual.
 * A complete line ends with '\n'. The residual is the trailing fragment.
 */
export function splitCompleteLines(
  chunk: string,
  residual: string,
): { lines: string[]; residual: string } {
  const combined = residual + chunk;
  const parts = combined.split('\n');
  // The last part is always the residual (empty string if chunk ended with \n)
  const newResidual = parts.pop()!;
  return { lines: parts, residual: newResidual };
}

/**
 * Build a line-offset index from an array of line strings.
 * Returns an array where index i is the byte offset where line i begins.
 * Assumes lines are contiguous and each terminated by '\n'.
 */
export function buildLineOffsetIndex(
  lines: string[],
  startOffset: number,
): number[] {
  const offsets: number[] = [];
  let offset = startOffset;
  for (const line of lines) {
    offsets.push(offset);
    offset += Buffer.byteLength(line, 'utf-8') + 1; // +1 for '\n'
  }
  return offsets;
}

/**
 * Given a line-offsets array and a 1-indexed line number,
 * return the byte offset where that line begins.
 * Returns undefined if the line number is out of range.
 */
export function seekToLine(
  offsets: number[],
  lineNumber: number,
): number | undefined {
  const idx = lineNumber - 1; // Convert 1-indexed to 0-indexed
  if (idx < 0 || idx >= offsets.length) return undefined;
  return offsets[idx];
}

// --- SSE Broker implementation ---

export interface SSEClient {
  id: string;
  cursor: number; // last emitted line number (1-indexed)
  write: (chunk: string) => void;
  close: () => void;
}

export interface SSEBroker {
  subscribe(
    sessionId: string,
    lastEventId: number | undefined,
    write: (chunk: string) => void,
    close: () => void,
  ): string; // returns clientId
  unsubscribe(sessionId: string, clientId: string): void;
  shutdown(): void;
}

interface SessionState {
  clients: Map<string, SSEClient>;
  pollTimer: ReturnType<typeof setInterval> | null;
  byteOffset: number;
  lineCount: number;
  residual: string;
  lineOffsets: number[];
  streamPath: string;
  ended: boolean;
}

export function createSSEBroker(deps: {
  sessionFiles: SessionFiles;
  rootDir: string;
  log: Logger;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}): SSEBroker {
  const { sessionFiles, rootDir, log } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? 250;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 30000;

  const sessions = new Map<string, SessionState>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function getStreamPath(sessionId: string): string {
    return path.join(rootDir, 'sessions', sessionId, 'stream.log');
  }

  function formatSSE(line: string, lineNumber: number, isSessionEnded: boolean): string {
    const eventType = isSessionEnded ? 'session_ended' : 'log';
    return `event: ${eventType}\nid: ${lineNumber}\ndata: ${line}\n\n`;
  }

  function isSessionEndedLine(line: string): boolean {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return parsed['type'] === 'session_ended';
    } catch {
      return false;
    }
  }

  function isTerminalStatus(status: string): boolean {
    return status === 'completed' || status === 'abandoned' || status === 'failed';
  }

  function emitToClient(client: SSEClient, line: string, lineNumber: number): void {
    if (lineNumber <= client.cursor) return; // dedup
    const ended = isSessionEndedLine(line);
    client.write(formatSSE(line, lineNumber, ended));
    client.cursor = lineNumber;
  }

  function readNewBytes(state: SessionState): void {
    let fd: number;
    try {
      fd = fs.openSync(state.streamPath, 'r');
    } catch {
      return;
    }

    try {
      const stat = fs.fstatSync(fd);
      const fileSize = stat.size;
      if (fileSize <= state.byteOffset) return;

      const bytesToRead = fileSize - state.byteOffset;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, state.byteOffset);
      const chunk = buffer.toString('utf-8');

      const { lines, residual } = splitCompleteLines(chunk, state.residual);
      const newOffsets = buildLineOffsetIndex(lines, state.byteOffset);

      state.residual = residual;
      state.byteOffset = fileSize - Buffer.byteLength(residual, 'utf-8');
      state.lineOffsets.push(...newOffsets);

      for (let i = 0; i < lines.length; i++) {
        state.lineCount++;
        const lineNumber = state.lineCount;
        const line = lines[i]!;
        const ended = isSessionEndedLine(line);

        for (const client of state.clients.values()) {
          emitToClient(client, line, lineNumber);
        }

        if (ended) {
          state.ended = true;
          // Close all clients
          for (const client of state.clients.values()) {
            client.close();
          }
          state.clients.clear();
          stopPollTimer(state);
          return;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  function stopPollTimer(state: SessionState): void {
    if (state.pollTimer !== null) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPollTimer(state: SessionState): void {
    if (state.pollTimer !== null) return;
    state.pollTimer = setInterval(() => readNewBytes(state), pollIntervalMs);
  }

  function ensureHeartbeat(): void {
    if (heartbeatTimer !== null) return;
    heartbeatTimer = setInterval(() => {
      for (const state of sessions.values()) {
        for (const client of state.clients.values()) {
          client.write(':heartbeat\n\n');
        }
      }
    }, heartbeatIntervalMs);
  }

  function checkHeartbeat(): void {
    // If no clients anywhere, stop heartbeat
    let hasClients = false;
    for (const state of sessions.values()) {
      if (state.clients.size > 0) {
        hasClients = true;
        break;
      }
    }
    if (!hasClients && heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function getOrCreateState(sessionId: string): SessionState {
    let state = sessions.get(sessionId);
    if (state) return state;

    state = {
      clients: new Map(),
      pollTimer: null,
      byteOffset: 0,
      lineCount: 0,
      residual: '',
      lineOffsets: [],
      streamPath: getStreamPath(sessionId),
      ended: false,
    };
    sessions.set(sessionId, state);
    return state;
  }

  function replayBacklog(
    state: SessionState,
    client: SSEClient,
    fromLine: number,
  ): void {
    // Read the entire file from the appropriate offset
    let startByte = 0;
    if (fromLine > 1) {
      // Check if we have cached offsets
      const cachedOffset = seekToLine(state.lineOffsets, fromLine);
      if (cachedOffset !== undefined) {
        startByte = cachedOffset;
      } else {
        // Re-scan from beginning counting lines
        startByte = scanToLine(state.streamPath, fromLine);
      }
    }

    let fd: number;
    try {
      fd = fs.openSync(state.streamPath, 'r');
    } catch {
      return;
    }

    try {
      const stat = fs.fstatSync(fd);
      const bytesToRead = stat.size - startByte;
      if (bytesToRead <= 0) return;

      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, startByte);
      const chunk = buffer.toString('utf-8');

      const { lines, residual } = splitCompleteLines(chunk, '');

      // Determine starting line number
      let lineNumber = fromLine > 0 ? fromLine : 1;

      // If state hasn't been initialized yet (first subscriber), populate it
      if (state.lineCount === 0 && fromLine <= 1) {
        state.lineOffsets = buildLineOffsetIndex(lines, startByte);
        state.lineCount = lines.length;
        state.byteOffset = stat.size - Buffer.byteLength(residual, 'utf-8');
        state.residual = residual;
      }

      for (const line of lines) {
        const ended = isSessionEndedLine(line);
        client.write(formatSSE(line, lineNumber, ended));
        client.cursor = lineNumber;
        if (ended) {
          state.ended = true;
        }
        lineNumber++;
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  function scanToLine(streamPath: string, targetLine: number): number {
    let fd: number;
    try {
      fd = fs.openSync(streamPath, 'r');
    } catch {
      return 0;
    }
    try {
      const stat = fs.fstatSync(fd);
      const buffer = Buffer.alloc(stat.size);
      fs.readSync(fd, buffer, 0, stat.size, 0);
      const content = buffer.toString('utf-8');
      let lineNum = 1;
      let byteOffset = 0;
      for (let i = 0; i < content.length; i++) {
        if (lineNum === targetLine) return byteOffset;
        if (content[i] === '\n') {
          lineNum++;
          byteOffset = Buffer.byteLength(content.slice(0, i + 1), 'utf-8');
        }
      }
      return byteOffset;
    } finally {
      fs.closeSync(fd);
    }
  }

  return {
    subscribe(
      sessionId: string,
      lastEventId: number | undefined,
      write: (chunk: string) => void,
      close: () => void,
    ): string {
      const clientId = crypto.randomUUID();
      const state = getOrCreateState(sessionId);

      const client: SSEClient = {
        id: clientId,
        cursor: lastEventId ?? 0,
        write,
        close,
      };

      // Check if session is already terminal
      let alreadyTerminal = false;
      try {
        const meta = sessionFiles.readMeta(sessionId);
        alreadyTerminal = isTerminalStatus(meta.status);
      } catch {
        // If we can't read meta, proceed anyway
      }

      // Phase 1: Backlog replay
      const fromLine = (lastEventId ?? 0) + 1;
      replayBacklog(state, client, fromLine);

      if (state.ended || alreadyTerminal) {
        // Already terminal — close immediately after replay
        close();
        return clientId;
      }

      // Phase 2: Live tail
      state.clients.set(clientId, client);

      // Ensure state is caught up to current file position
      if (state.lineCount === 0) {
        // State wasn't populated by replay (e.g. lastEventId was past end)
        // Force a read to initialize offsets
        readNewBytes(state);
      }

      startPollTimer(state);
      ensureHeartbeat();

      return clientId;
    },

    unsubscribe(sessionId: string, clientId: string): void {
      const state = sessions.get(sessionId);
      if (!state) return;

      state.clients.delete(clientId);

      if (state.clients.size === 0) {
        stopPollTimer(state);
        checkHeartbeat();
      }
    },

    shutdown(): void {
      for (const state of sessions.values()) {
        stopPollTimer(state);
        for (const client of state.clients.values()) {
          client.close();
        }
        state.clients.clear();
      }
      sessions.clear();
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
  };
}
