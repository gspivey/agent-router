import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Logger } from './log.js';

/**
 * Warn when a manual `install-mcp-config.sh` entry conflicts with per-session
 * MCP wiring.
 *
 * If `<homeDir>/.kiro/settings/mcp.json` contains an `agent-router` key under
 * `mcpServers`, that global entry is now redundant (and conflicts) because the
 * daemon wires the MCP server into every session automatically. The operator
 * should remove it. This logs a `warn` and otherwise does nothing — the entry
 * is not removed programmatically.
 *
 * `homeDir` is injected (rather than read from `os.homedir()` internally) so a
 * Tier 1 test can point the check at a temp directory.
 */
export function warnOnConflictingMcpConfig(homeDir: string, log: Logger): void {
  const configPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json');

  let raw: string;
  try {
    if (!fs.existsSync(configPath)) return;
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return; // unreadable — nothing to warn about
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // malformed — not our concern here
  }

  if (typeof parsed !== 'object' || parsed === null) return;
  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (typeof servers !== 'object' || servers === null) return;

  if (Object.prototype.hasOwnProperty.call(servers, 'agent-router')) {
    log.warn(
      'A manual "agent-router" entry exists in ~/.kiro/settings/mcp.json. ' +
        'It is superseded by automatic per-session MCP wiring and should be ' +
        'removed to avoid duplicate tool registration.',
      { configPath },
    );
  }
}
