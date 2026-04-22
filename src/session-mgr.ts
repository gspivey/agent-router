import type { Database } from './db';
import type { Logger } from './log';
import type { SessionFiles, SessionPaths, PromptSource } from './session-files';
import type { EventQueue } from './queue';
import type { ACPClient } from './acp';

export interface SessionHandle {
  sessionId: string;
  paths: SessionPaths;
  acp: ACPClient;
  eventQueue: EventQueue;
  kiroPid: number;
}

export interface SessionManager {
  createSession(originalPrompt: string): Promise<SessionHandle>;
  injectPrompt(sessionId: string, prompt: string, source: PromptSource): Promise<void>;
  registerPR(sessionId: string, repo: string, prNumber: number): Promise<void>;
  terminateSession(sessionId: string): Promise<void>;
  getActiveSession(sessionId: string): SessionHandle | null;
  shutdown(): Promise<void>;
}

export function createSessionManager(deps: {
  db: Database;
  sessionFiles: SessionFiles;
  acpSpawner: (sessionId: string) => ACPClient;
  log: Logger;
}): SessionManager {
  throw new Error('Not implemented');
}
