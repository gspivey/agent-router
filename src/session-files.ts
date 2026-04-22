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
  prs: Array<{ repo: string; pr_number: number; registered_at: number }>;
}

export type PromptSource = 'cli' | 'webhook' | 'cron' | 'mcp';

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

export function createSessionFiles(rootDir: string): SessionFiles {
  throw new Error('Not implemented');
}
