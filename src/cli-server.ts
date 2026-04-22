import type { Logger } from './log';
import type { SessionManager } from './session-mgr';
import type { SessionFiles } from './session-files';

export interface CliRequest {
  op: 'new_session' | 'list_sessions' | 'inject_prompt' | 'terminate_session';
  [key: string]: unknown;
}

export interface CliServer {
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createCliServer(deps: {
  socketPath: string;
  sessionMgr: SessionManager;
  sessionFiles: SessionFiles;
  log: Logger;
}): CliServer {
  throw new Error('Not implemented');
}
