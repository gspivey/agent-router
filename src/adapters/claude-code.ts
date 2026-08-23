/**
 * ClaudeCodeAdapter — spawns @agentclientprotocol/claude-agent-acp via npx.
 *
 * Mirrors the KiroAdapter structure: a factory function that closes over
 * injected deps and returns an AgentAdapter. The `spawnImpl` dep allows
 * tests to assert spawn args without launching a real child process.
 *
 * The package is invoked via `npx` so operators don't need to pre-install
 * it — npx handles download and caching. The `--acp` flag puts the package
 * into stdio ACP server mode (JSON-RPC 2.0 over stdin/stdout).
 */
import type { ACPClient } from '../acp.js';
import type { AgentAdapter, AdapterCapabilities, SpawnOpts } from '../agent-adapter.js';
import type { Logger } from '../log.js';
import { spawnACPClient } from '../acp.js';

export interface ClaudeCodeAdapterDeps {
  /** Optional model override (e.g. "claude-opus-5"). Injected as ANTHROPIC_MODEL. */
  model?: string;
  log: Logger;
  /** Override spawn for testing. */
  spawnImpl?: (bin: string, args: string[], env: Record<string, string>) => ACPClient;
}

export function createClaudeCodeAdapter(deps: ClaudeCodeAdapterDeps): AgentAdapter {
  const spawnFn = deps.spawnImpl ?? spawnACPClient;

  return {
    name: 'claude-code',

    capabilities(): AdapterCapabilities {
      return {
        events: ['session.start', 'tool.post', 'turn.end', 'session.end'],
        perToolMatching: true,
      };
    },

    spawn(opts: SpawnOpts): ACPClient {
      const env: Record<string, string> = {
        ...(opts.env ?? {}),
        AGENT_ROUTER_SESSION_ID: opts.sessionId,
      };
      if (deps.model) {
        env['ANTHROPIC_MODEL'] = deps.model;
      }
      return spawnFn(
        'npx',
        ['@agentclientprotocol/claude-agent-acp@latest', '--acp'],
        env,
      );
    },

    async installHooks(_daemonUrl: string, _token: string): Promise<void> {
      deps.log.info('ClaudeCodeAdapter.installHooks is a stub in this version');
    },

    async uninstallHooks(): Promise<void> {
      // No-op stub
    },
  };
}
