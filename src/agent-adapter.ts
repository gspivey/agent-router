/**
 * AgentAdapter — the abstraction over a coding-agent harness.
 *
 * The daemon holds exactly one active adapter (selected at startup). Today
 * that's hardcoded to KiroAdapter; the interface exists so a future second
 * adapter (Claude Code, OpenCode, Codex) is a single new file under
 * src/adapters/ rather than a refactor of src/index.ts.
 *
 * Three responsibilities:
 *  1. `spawn` — start an agent subprocess, returning an ACPClient.
 *  2. `installHooks` / `uninstallHooks` — wire the agent harness's
 *     hook system so it POSTs to the daemon's /hooks/event endpoint on
 *     lifecycle events. In this version, the Kiro implementation is a
 *     documentation-only stub (see docs/kiro-hooks.md). The hook surface
 *     stays in the interface so the next adapter can implement it.
 *  3. `capabilities()` — declares what lifecycle events the adapter can
 *     drive, and whether it supports per-tool matching in tool.post.
 *     Different agents have different hook capabilities (e.g., Codex
 *     intercepts Bash but not MCP — that's a `perToolMatching: false`
 *     adapter). The verification core doesn't care; this is metadata for
 *     diagnostics and for future adapter-selection logic.
 */
import type { ACPClient } from './acp.js';

export type HookEventType = 'session.start' | 'tool.post' | 'turn.end' | 'session.end';

export interface AdapterCapabilities {
  /** Lifecycle events this adapter can drive through /hooks/event. */
  events: ReadonlyArray<HookEventType>;
  /**
   * Whether the adapter's hook system can match on specific tool names in
   * tool.post events. Kiro/Claude Code can; Codex's PreToolUse/PostToolUse
   * only intercept Bash.
   */
  perToolMatching: boolean;
}

export interface SpawnOpts {
  /** The agent-router session id, injected as AGENT_ROUTER_SESSION_ID. */
  sessionId: string;
  /** Optional additional environment variables for the child process. */
  env?: Record<string, string>;
  /**
   * When true, launch the agent as the unprivileged `agentworker` user via
   * sudo and withhold GITHUB_TOKEN from the child env (agent process
   * isolation, FR-2.2). Default false — unchanged behavior.
   */
  useWorkerUid?: boolean;
  /**
   * Per-session capability token the MCP server presents to the agent socket.
   * Forwarded to the child as AGENT_ROUTER_CAP_TOKEN when `useWorkerUid` is
   * true.
   */
  capToken?: string;
  /**
   * Agent-only socket path, forwarded to the child as AGENT_ROUTER_AGENT_SOCK
   * when `useWorkerUid` is true.
   */
  agentSocketPath?: string;
}

export interface AgentAdapter {
  /** Stable identifier for diagnostics, e.g. "kiro". */
  readonly name: string;
  capabilities(): AdapterCapabilities;
  spawn(opts: SpawnOpts): ACPClient;
  /**
   * Wire the agent harness's hooks to POST to the given daemon URL with the
   * given bearer token. The current Kiro implementation is a documentation
   * stub; users hand-edit ~/.kiro/agents/agent-router.json per docs/kiro-hooks.md.
   */
  installHooks(daemonUrl: string, token: string): Promise<void>;
  uninstallHooks(): Promise<void>;
}
