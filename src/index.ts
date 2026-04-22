import type { AgentRouterConfig } from './config';
import type { Database } from './db';
import type { Logger } from './log';
import type { SessionManager } from './session-mgr';
import type { CliServer } from './cli-server';
import type { EventQueue } from './queue';
import { FatalError, EventError, WakeError } from './errors';

export { FatalError, EventError, WakeError };

// Entry point: load config → init logger → init database → init session infrastructure → start servers
