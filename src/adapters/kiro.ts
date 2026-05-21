/**
 * KiroAdapter — the one concrete AgentAdapter implementation.
 *
 * Spawn behavior is byte-identical to the previous inline `acpSpawner`
 * lambda in src/index.ts. The encapsulation is the refactor.
 *
 * installHooks / uninstallHooks are documentation-only stubs in this
 * version — see docs/kiro-hooks.md for the JSON snippet to hand-paste
 * into ~/.kiro/agents/agent-router.json if the user wants the sub-second
 * verification path. Automatic installation is deferred until production
 * usage data shows the latency win matters.
 */
import type { ACPClient } from '../acp.js';
import type { AgentAdapter, AdapterCapabilities, SpawnOpts } from '../agent-adapter.js';
import type { Logger } from '../log.js';
import { spawnACPClient } from '../acp.js';

export interface KiroAdapterDeps {
  /** Absolute path to the kiro executable. */
  kiroPath: string;
  log: Logger;
  /**
   * Override the spawn function. Tests use this to assert the spawn args
   * without actually launching a child process.
   */
  spawnImpl?: (kiroPath: string, args: string[], env: Record<string, string>) => ACPClient;
}

export function createKiroAdapter(deps: KiroAdapterDeps): AgentAdapter {
  const spawnFn = deps.spawnImpl ?? spawnACPClient;

  return {
    name: 'kiro',

    capabilities(): AdapterCapabilities {
      // Kiro could drive all four event types if hooks were installed.
      // The interface reports the *potential* capability — the verifier
      // doesn't care whether hooks are wired today or hand-installed later.
      return {
        events: ['session.start', 'tool.post', 'turn.end', 'session.end'],
        perToolMatching: true,
      };
    },

    spawn(opts: SpawnOpts): ACPClient {
      return spawnFn(deps.kiroPath, ['acp'], {
        ...(opts.env ?? {}),
        AGENT_ROUTER_SESSION_ID: opts.sessionId,
      });
    },

    async installHooks(_daemonUrl: string, _token: string): Promise<void> {
      // Intentional stub. See docs/kiro-hooks.md for the hand-install snippet.
      // The interface keeps this method so the next adapter (or a future
      // implementation of this one) can wire automatic installation without
      // changing the call site.
      deps.log.info(
        'KiroAdapter.installHooks is documentation-only in this version; ' +
          'see docs/kiro-hooks.md for the hand-install snippet',
      );
    },

    async uninstallHooks(): Promise<void> {
      // No-op stub — nothing was installed.
    },
  };
}
