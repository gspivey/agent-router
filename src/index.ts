import * as path from 'node:path';
import { loadConfig } from './config.js';
import { FatalError, EventError, WakeError } from './errors.js';

export { FatalError, EventError, WakeError };

// Entry point: load config → init logger → init database → init session infrastructure → start servers

const rootDir = process.env['AGENT_ROUTER_HOME'] ?? path.join(process.env['HOME'] ?? '.', '.agent-router');
const configPath = path.join(rootDir, 'config.json');

try {
  const config = loadConfig(configPath);
  // TODO: init logger, init database, start servers
} catch (err: unknown) {
  if (err instanceof FatalError) {
    process.stderr.write(`FatalError: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
