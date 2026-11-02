/**
 * Tier 1 tests: KiroAdapter.installHooks and uninstallHooks.
 *
 * These tests cover the hook file read-modify-write logic:
 * 1. installHooks writes the expected JSON shape to ~/.kiro/agents/agent-router.json
 * 2. installHooks merges into an existing file (preserves other fields and other hooks)
 * 3. installHooks is idempotent (re-installing the same sessionId replaces entries)
 * 4. uninstallHooks removes entries by sessionId without disturbing other fields
 * 5. uninstallHooks with no sessionId removes all agent-router-managed entries
 * 6. uninstallHooks is a no-op when the file does not exist
 * 7. uninstallHooks is a no-op when the entries are already absent
 * 8. installHooks logs a warning and returns (without throwing) on write failure
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createKiroAdapter } from '../../src/adapters/kiro.js';
import { createLogger } from '../../src/log.js';
import type { ACPClient } from '../../src/acp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLog() {
  return createLogger({ level: 'error', output: () => {} });
}

function fakeAcpClient(): ACPClient {
  return {
    initialize: async () => {},
    newSession: async () => 'fake',
    newSessionWithPrompt: async () => 'fake',
    loadSession: async () => {},
    sendPrompt: async () => {},
    cancel: () => {},
    notifications: (async function* () {})(),
    sessionEnded: Promise.resolve(),
    close: async () => {},
    kill: async () => {},
  };
}

function readAgentConfig(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

interface HookEntry {
  name: string;
  match?: { toolName: string };
  command: string;
}

interface AgentConfig {
  hooks?: {
    postToolUse?: HookEntry[];
    agentStop?: HookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let agentConfigDir: string;
let agentConfigPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-install-hooks-t1-'));
  agentConfigDir = path.join(tmpDir, '.kiro', 'agents');
  agentConfigPath = path.join(agentConfigDir, 'agent-router.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeAdapter(log = silentLog()) {
  return createKiroAdapter({
    kiroPath: '/usr/local/bin/kiro',
    log,
    homeDir: tmpDir,
    spawnImpl: () => fakeAcpClient(),
  });
}

// ---------------------------------------------------------------------------
// Tests: installHooks
// ---------------------------------------------------------------------------

describe('KiroAdapter.installHooks', () => {
  it('creates the agent config file with the expected hooks shape', async () => {
    const adapter = makeAdapter();

    await adapter.installHooks({
      sessionId: 'sess-001',
      daemonUrl: 'http://127.0.0.1:3000',
      bearerToken: 'tok-abc',
    });

    expect(fs.existsSync(agentConfigPath)).toBe(true);

    const cfg = readAgentConfig(agentConfigPath) as AgentConfig;
    expect(cfg.hooks).toBeDefined();

    // postToolUse entry
    const ptu = cfg.hooks!.postToolUse ?? [];
    expect(ptu.length).toBeGreaterThanOrEqual(1);
    const ptuEntry = ptu.find((e) => e.name.includes('merge_pr') && e.name.includes('sess-001'));
    expect(ptuEntry).toBeDefined();
    expect(ptuEntry!.match?.toolName).toBe('@agent-router/merge_pr');
    expect(ptuEntry!.command).toContain('http://127.0.0.1:3000/hooks/event');
    expect(ptuEntry!.command).toContain('tool.post');

    // agentStop entry
    const as = cfg.hooks!.agentStop ?? [];
    expect(as.length).toBeGreaterThanOrEqual(1);
    const asEntry = as.find((e) => e.name.includes('turn end') && e.name.includes('sess-001'));
    expect(asEntry).toBeDefined();
    expect(asEntry!.command).toContain('http://127.0.0.1:3000/hooks/event');
    expect(asEntry!.command).toContain('turn.end');
  });

  it('preserves existing hook entries from other sources', async () => {
    // Pre-write a file with a user-defined hook
    fs.mkdirSync(agentConfigDir, { recursive: true });
    const initialConfig: AgentConfig = {
      someOtherField: 'preserved',
      hooks: {
        postToolUse: [{ name: 'my-own-hook', command: 'echo hello' }],
        agentStop: [],
      },
    };
    fs.writeFileSync(agentConfigPath, JSON.stringify(initialConfig, null, 2));

    const adapter = makeAdapter();
    await adapter.installHooks({
      sessionId: 'sess-002',
      daemonUrl: 'http://127.0.0.1:3000',
      bearerToken: 'tok-xyz',
    });

    const cfg = readAgentConfig(agentConfigPath) as AgentConfig;

    // User's own hook is preserved
    const ptu = cfg.hooks!.postToolUse ?? [];
    expect(ptu.some((e) => e.name === 'my-own-hook')).toBe(true);

    // Our new hook is also present
    expect(ptu.some((e) => e.name.includes('sess-002'))).toBe(true);

    // Other fields preserved
    expect((cfg as AgentConfig).someOtherField).toBe('preserved');
  });

  it('is idempotent — re-installing for the same sessionId replaces, not duplicates', async () => {
    const adapter = makeAdapter();

    await adapter.installHooks({
      sessionId: 'sess-003',
      daemonUrl: 'http://127.0.0.1:3000',
      bearerToken: 'tok-1',
    });

    // Second install for the same session (same URL, different token — simulates
    // a daemon restart rotating the token)
    await adapter.installHooks({
      sessionId: 'sess-003',
      daemonUrl: 'http://127.0.0.1:3001',
      bearerToken: 'tok-2',
    });

    const cfg = readAgentConfig(agentConfigPath) as AgentConfig;

    // Should have exactly ONE postToolUse entry for sess-003
    const ptu = cfg.hooks!.postToolUse ?? [];
    const ours = ptu.filter((e) => e.name.includes('sess-003'));
    expect(ours).toHaveLength(1);
    // The retained entry should have the NEWER url
    expect(ours[0]!.command).toContain('http://127.0.0.1:3001');

    const as = cfg.hooks!.agentStop ?? [];
    const ourAs = as.filter((e) => e.name.includes('sess-003'));
    expect(ourAs).toHaveLength(1);
  });

  it('creates parent directories if they do not exist', async () => {
    const adapter = makeAdapter();

    // Verify the dir does not exist before the call
    expect(fs.existsSync(agentConfigDir)).toBe(false);

    await adapter.installHooks({
      sessionId: 'sess-004',
      daemonUrl: 'http://127.0.0.1:3000',
      bearerToken: 'tok-abc',
    });

    expect(fs.existsSync(agentConfigDir)).toBe(true);
    expect(fs.existsSync(agentConfigPath)).toBe(true);
  });

  it('logs a warning and does not throw on write failure (homeDir is a file)', async () => {
    // Make the agent config path a *file* so mkdirSync fails
    const badTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-bad-'));
    try {
      const kiroDir = path.join(badTmpDir, '.kiro');
      // Create .kiro as a FILE (not a dir) so the agents subdir can't be created
      fs.writeFileSync(kiroDir, 'I am a file, not a dir');

      const warnMessages: string[] = [];
      const capturingLog = createLogger({
        level: 'warn',
        output: (line: string) => {
          // The logger outputs NDJSON strings; capture lines that contain "warn"
          if (line.includes('"warn"') || line.includes('"level":"warn"')) {
            warnMessages.push(line);
          }
        },
      });

      const adapter = createKiroAdapter({
        kiroPath: '/usr/local/bin/kiro',
        log: capturingLog,
        homeDir: badTmpDir,
        spawnImpl: () => fakeAcpClient(),
      });

      // Should NOT throw
      await expect(
        adapter.installHooks({
          sessionId: 'sess-005',
          daemonUrl: 'http://127.0.0.1:3000',
          bearerToken: 'tok-abc',
        }),
      ).resolves.toBeUndefined();

      // A warn was emitted
      expect(warnMessages.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(badTmpDir, { recursive: true, force: true });
    }
  });

  it('embeds the daemon token path (not the token value) in hook commands', async () => {
    const adapter = makeAdapter();
    await adapter.installHooks({
      sessionId: 'sess-006',
      daemonUrl: 'http://127.0.0.1:3000',
      bearerToken: 'should-not-appear-in-file',
    });

    const rawContent = fs.readFileSync(agentConfigPath, 'utf-8');

    // The bearer token value should NOT be embedded in the file
    expect(rawContent).not.toContain('should-not-appear-in-file');

    // The path to the daemon-token file should be embedded instead
    expect(rawContent).toContain('daemon-token');
  });
});

// ---------------------------------------------------------------------------
// Tests: uninstallHooks
// ---------------------------------------------------------------------------

describe('KiroAdapter.uninstallHooks', () => {
  it('removes only the entries for the specified sessionId', async () => {
    const adapter = makeAdapter();

    // Install hooks for two sessions
    await adapter.installHooks({
      sessionId: 'sess-A',
      daemonUrl: 'http://127.0.0.1:3000',
      bearerToken: 'tok',
    });
    await adapter.installHooks({
      sessionId: 'sess-B',
      daemonUrl: 'http://127.0.0.1:3000',
      bearerToken: 'tok',
    });

    // Uninstall only sess-A
    await adapter.uninstallHooks({ sessionId: 'sess-A' });

    const cfg = readAgentConfig(agentConfigPath) as AgentConfig;

    const ptu = cfg.hooks!.postToolUse ?? [];
    expect(ptu.some((e) => e.name.includes('sess-A'))).toBe(false);
    expect(ptu.some((e) => e.name.includes('sess-B'))).toBe(true);

    const as = cfg.hooks!.agentStop ?? [];
    expect(as.some((e) => e.name.includes('sess-A'))).toBe(false);
    expect(as.some((e) => e.name.includes('sess-B'))).toBe(true);
  });

  it('removes all agent-router-managed entries when no sessionId is given', async () => {
    const adapter = makeAdapter();

    // Pre-write a user hook
    fs.mkdirSync(agentConfigDir, { recursive: true });
    const initial: AgentConfig = {
      hooks: {
        postToolUse: [{ name: 'user-hook', command: 'echo hi' }],
        agentStop: [],
      },
    };
    fs.writeFileSync(agentConfigPath, JSON.stringify(initial, null, 2));

    await adapter.installHooks({
      sessionId: 'sess-C',
      daemonUrl: 'http://127.0.0.1:3000',
      bearerToken: 'tok',
    });

    // Uninstall with no sessionId — removes all agent-router entries
    await adapter.uninstallHooks();

    const cfg = readAgentConfig(agentConfigPath) as AgentConfig;

    const ptu = cfg.hooks!.postToolUse ?? [];
    // User's own hook is preserved
    expect(ptu.some((e) => e.name === 'user-hook')).toBe(true);
    // agent-router entries are gone
    expect(ptu.some((e) => e.name.startsWith('agent-router:'))).toBe(false);

    const as = cfg.hooks!.agentStop ?? [];
    expect(as.some((e) => e.name.startsWith('agent-router:'))).toBe(false);
  });

  it('is a no-op when the file does not exist', async () => {
    const adapter = makeAdapter();

    // File doesn't exist — should not throw
    await expect(adapter.uninstallHooks({ sessionId: 'sess-D' })).resolves.toBeUndefined();
    expect(fs.existsSync(agentConfigPath)).toBe(false);
  });

  it('is a no-op when the entries are already absent', async () => {
    const adapter = makeAdapter();

    // Write a file with no agent-router entries
    fs.mkdirSync(agentConfigDir, { recursive: true });
    const initial: AgentConfig = { hooks: { postToolUse: [{ name: 'user-hook', command: 'echo' }] } };
    fs.writeFileSync(agentConfigPath, JSON.stringify(initial, null, 2));

    const before = fs.statSync(agentConfigPath).mtimeMs;

    // Wait a tick to ensure mtime would differ if a write occurred
    await new Promise((r) => setTimeout(r, 50));

    await adapter.uninstallHooks({ sessionId: 'sess-E' });

    // File should not have been rewritten (no agent-router entries to remove)
    const after = fs.statSync(agentConfigPath).mtimeMs;
    expect(after).toBe(before);
  });

  it('preserves non-hook fields when removing entries', async () => {
    const adapter = makeAdapter();

    fs.mkdirSync(agentConfigDir, { recursive: true });
    const initial: AgentConfig = {
      customField: 'do not remove me',
      hooks: {
        postToolUse: [],
        agentStop: [],
      },
    };
    fs.writeFileSync(agentConfigPath, JSON.stringify(initial, null, 2));

    await adapter.installHooks({
      sessionId: 'sess-F',
      daemonUrl: 'http://127.0.0.1:3000',
      bearerToken: 'tok',
    });
    await adapter.uninstallHooks({ sessionId: 'sess-F' });

    const cfg = readAgentConfig(agentConfigPath) as AgentConfig & { customField?: string };
    expect(cfg.customField).toBe('do not remove me');
  });
});
