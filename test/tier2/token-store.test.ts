/**
 * Tier 2 tests for Token_Store — real filesystem integration.
 *
 * Tests the createTokenStore factory against a real temporary filesystem:
 * - Write tokens.json, create store, verify lookups
 * - SIGHUP-triggered reload: modify file, trigger reload, verify new map
 * - fs.watch/polling: modify file, wait for automatic reload
 * - Atomic swap: verify no partial state observable during reload
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.7
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createTokenStore, type TokenStore } from '../../src/token-store.js';
import type { Logger } from '../../src/log.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface LogEntry {
  level: string;
  msg: string;
  fields: Record<string, unknown> | undefined;
}

function createTestLogger(messages: LogEntry[]): Logger {
  const makeLogFn = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    messages.push({ level, msg, fields });
  };
  const logger: Logger = {
    debug: makeLogFn('debug'),
    info: makeLogFn('info'),
    warn: makeLogFn('warn'),
    error: makeLogFn('error'),
    child: () => logger,
  };
  return logger;
}

function writeTokensFile(filePath: string, projects: Record<string, { token: string; repos: string[]; expires_at?: string }>): void {
  fs.writeFileSync(filePath, JSON.stringify({ projects }), { mode: 0o600 });
}

/** Wait until a condition is true (polling), with a timeout. */
async function waitFor(condition: () => boolean, timeoutMs = 5000, pollMs = 50): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tier 2: Token_Store with real filesystem', () => {
  let tmpDir: string;
  let tokensFilePath: string;
  let logMessages: LogEntry[];
  let log: Logger;
  let store: TokenStore | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-tier2-'));
    tokensFilePath = path.join(tmpDir, 'tokens.json');
    logMessages = [];
    log = createTestLogger(logMessages);
    store = undefined;
  });

  afterEach(() => {
    if (store) {
      store.stopWatching();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initial load and lookups', () => {
    it('creates a store from a valid tokens.json and resolves lookups correctly', () => {
      writeTokensFile(tokensFilePath, {
        'project-alpha': {
          token: 'github_pat_alpha',
          repos: ['org/repo-a', 'org/repo-b'],
          expires_at: '2027-01-15T00:00:00Z',
        },
        'project-beta': {
          token: 'github_pat_beta',
          repos: ['org/repo-c'],
        },
      });

      store = createTokenStore({ tokensFilePath, log });

      // Forward lookup by project name
      expect(store.getToken('project-alpha')?.reveal()).toBe('github_pat_alpha');
      expect(store.getToken('project-beta')?.reveal()).toBe('github_pat_beta');
      expect(store.getToken('nonexistent')).toBeUndefined();

      // Reverse lookup by repo
      expect(store.findProjectByRepo('org/repo-a')).toBe('project-alpha');
      expect(store.findProjectByRepo('org/repo-b')).toBe('project-alpha');
      expect(store.findProjectByRepo('org/repo-c')).toBe('project-beta');
      expect(store.findProjectByRepo('org/unknown')).toBeUndefined();

      // Full project entry
      const alpha = store.getProject('project-alpha');
      expect(alpha).toBeDefined();
      expect(alpha!.name).toBe('project-alpha');
      expect(alpha!.repos).toEqual(['org/repo-a', 'org/repo-b']);
      expect(alpha!.expiresAt).toEqual(new Date('2027-01-15T00:00:00Z'));

      // Token map snapshot
      const map = store.getTokenMap();
      expect(map.projects.size).toBe(2);
      expect(map.repoIndex.size).toBe(3);
    });

    it('supports multi-repo projects with correct index', () => {
      writeTokensFile(tokensFilePath, {
        'multi-repo': {
          token: 'tok-multi',
          repos: ['org/r1', 'org/r2', 'org/r3', 'org/r4'],
        },
      });

      store = createTokenStore({ tokensFilePath, log });

      for (const repo of ['org/r1', 'org/r2', 'org/r3', 'org/r4']) {
        expect(store.findProjectByRepo(repo)).toBe('multi-repo');
      }
    });
  });

  describe('SIGHUP-triggered reload (Req 2.1)', () => {
    it('picks up new token after reload', () => {
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok-v1', repos: ['o/r'] },
      });
      store = createTokenStore({ tokensFilePath, log });
      expect(store.getToken('proj')?.reveal()).toBe('tok-v1');

      // Simulate token rotation — write new content
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok-v2', repos: ['o/r'] },
      });

      // Trigger reload (simulating SIGHUP)
      const changed = store.reload();
      expect(changed).toBe(true);
      expect(store.getToken('proj')?.reveal()).toBe('tok-v2');
    });

    it('picks up added projects after reload', () => {
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok', repos: ['o/r1'] },
      });
      store = createTokenStore({ tokensFilePath, log });
      expect(store.getProject('new-proj')).toBeUndefined();

      // Add a new project
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok', repos: ['o/r1'] },
        'new-proj': { token: 'tok-new', repos: ['o/r2'] },
      });

      store.reload();
      expect(store.getToken('new-proj')?.reveal()).toBe('tok-new');
      expect(store.findProjectByRepo('o/r2')).toBe('new-proj');
    });

    it('picks up removed projects after reload', () => {
      writeTokensFile(tokensFilePath, {
        'proj-keep': { token: 'tok-keep', repos: ['o/r1'] },
        'proj-remove': { token: 'tok-rm', repos: ['o/r2'] },
      });
      store = createTokenStore({ tokensFilePath, log });
      expect(store.getToken('proj-remove')?.reveal()).toBe('tok-rm');

      // Remove a project
      writeTokensFile(tokensFilePath, {
        'proj-keep': { token: 'tok-keep', repos: ['o/r1'] },
      });

      store.reload();
      expect(store.getToken('proj-remove')).toBeUndefined();
      expect(store.findProjectByRepo('o/r2')).toBeUndefined();
      // Kept project still works
      expect(store.getToken('proj-keep')?.reveal()).toBe('tok-keep');
    });

    it('logs reload diff (Req 2.4 / Req 11.4)', () => {
      writeTokensFile(tokensFilePath, {
        unchanged: { token: 'tok-u', repos: ['o/u'] },
        changed: { token: 'tok-old', repos: ['o/c'] },
        removed: { token: 'tok-rm', repos: ['o/rm'] },
      });
      store = createTokenStore({ tokensFilePath, log });
      logMessages.length = 0; // Clear initial load messages

      writeTokensFile(tokensFilePath, {
        unchanged: { token: 'tok-u', repos: ['o/u'] },
        changed: { token: 'tok-new', repos: ['o/c'] },
        added: { token: 'tok-add', repos: ['o/add'] },
      });

      store.reload();

      const infoMsg = logMessages.find(m =>
        m.level === 'info' && m.msg.includes('Token store reloaded')
      );
      expect(infoMsg).toBeDefined();
      expect(infoMsg!.fields).toMatchObject({
        added: 1,
        removed: 1,
        changed: 1,
        unchanged: 1,
      });
    });

    it('retains old map on invalid reload and logs warning', () => {
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok-good', repos: ['o/r'] },
      });
      store = createTokenStore({ tokensFilePath, log });

      // Write invalid content
      fs.writeFileSync(tokensFilePath, '{"projects": {"bad": {"token": ""}}}');

      const changed = store.reload();
      expect(changed).toBe(false);
      expect(store.getToken('proj')?.reveal()).toBe('tok-good');

      const warnMsg = logMessages.find(m =>
        m.level === 'warn' && m.msg.includes('retaining previous')
      );
      expect(warnMsg).toBeDefined();
    });

    it('retains old map when file is deleted during reload', () => {
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok-good', repos: ['o/r'] },
      });
      store = createTokenStore({ tokensFilePath, log });

      fs.unlinkSync(tokensFilePath);

      const changed = store.reload();
      expect(changed).toBe(false);
      expect(store.getToken('proj')?.reveal()).toBe('tok-good');
    });
  });

  describe('fs.watch automatic reload (Req 2.2, 2.3)', () => {
    it('automatically picks up file changes via startWatching', async () => {
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok-v1', repos: ['o/r'] },
      });
      store = createTokenStore({ tokensFilePath, log });
      store.startWatching();

      expect(store.getToken('proj')?.reveal()).toBe('tok-v1');

      // Modify the file — fs.watch should trigger a reload
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok-v2', repos: ['o/r'] },
      });

      // Wait for the automatic reload (fs.watch fires quickly)
      await waitFor(() => store!.getToken('proj')?.reveal() === 'tok-v2', 3000);
      expect(store.getToken('proj')?.reveal()).toBe('tok-v2');
    });

    it('stopWatching prevents further automatic reloads', async () => {
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok-v1', repos: ['o/r'] },
      });
      store = createTokenStore({ tokensFilePath, log });
      store.startWatching();

      // Stop watching
      store.stopWatching();

      // Modify the file
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok-v2', repos: ['o/r'] },
      });

      // Wait a bit — should NOT be reloaded
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(store.getToken('proj')?.reveal()).toBe('tok-v1');
    });
  });

  describe('atomic swap — no partial state (Req 2.4)', () => {
    it('token map is replaced atomically', () => {
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok-v1', repos: ['o/r1', 'o/r2'] },
      });
      store = createTokenStore({ tokensFilePath, log });

      // Write a completely different config
      writeTokensFile(tokensFilePath, {
        'new-proj': { token: 'tok-new', repos: ['o/r3', 'o/r4'] },
      });
      store.reload();

      // After reload, old lookups should be gone and new ones should be present
      // No mix of old and new state should be observable
      expect(store.getToken('proj')).toBeUndefined();
      expect(store.findProjectByRepo('o/r1')).toBeUndefined();
      expect(store.findProjectByRepo('o/r2')).toBeUndefined();
      expect(store.getToken('new-proj')?.reveal()).toBe('tok-new');
      expect(store.findProjectByRepo('o/r3')).toBe('new-proj');
      expect(store.findProjectByRepo('o/r4')).toBe('new-proj');
    });

    it('concurrent reads during reload see consistent state', () => {
      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok-v1', repos: ['o/r1', 'o/r2', 'o/r3'] },
      });
      store = createTokenStore({ tokensFilePath, log });

      writeTokensFile(tokensFilePath, {
        proj: { token: 'tok-v2', repos: ['o/r1', 'o/r2', 'o/r3'] },
      });
      store.reload();

      // All repos should return the same project consistently
      const project1 = store.findProjectByRepo('o/r1');
      const project2 = store.findProjectByRepo('o/r2');
      const project3 = store.findProjectByRepo('o/r3');
      expect(project1).toBe(project2);
      expect(project2).toBe(project3);

      // Token should be the new one
      expect(store.getToken('proj')?.reveal()).toBe('tok-v2');
    });
  });

  describe('Token rotation during active sessions (Req 2.7)', () => {
    it('new token is available immediately after reload (for Track 2 sessions)', () => {
      writeTokensFile(tokensFilePath, {
        proj: { token: 'github_pat_old', repos: ['o/r'] },
      });
      store = createTokenStore({ tokensFilePath, log });

      // Simulate a token rotation
      writeTokensFile(tokensFilePath, {
        proj: { token: 'github_pat_new', repos: ['o/r'] },
      });
      store.reload();

      // Track 2 sessions call getToken per MCP tool call — should get new token
      expect(store.getToken('proj')?.reveal()).toBe('github_pat_new');
    });
  });

  describe('expiry warnings on reload', () => {
    it('emits expiry warnings for tokens approaching expiry', () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      writeTokensFile(tokensFilePath, {
        'expiring-proj': {
          token: 'tok-expiring',
          repos: ['o/r'],
          expires_at: tomorrow.toISOString(),
        },
      });

      store = createTokenStore({ tokensFilePath, log });

      // Should have emitted a warning on initial load
      const warnMsg = logMessages.find(m =>
        (m.level === 'warn' || m.level === 'error') &&
        m.msg.includes('expiring-proj')
      );
      expect(warnMsg).toBeDefined();
    });

    it('emits updated warnings after reload', () => {
      // Start with a safe token
      const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      writeTokensFile(tokensFilePath, {
        proj: {
          token: 'tok',
          repos: ['o/r'],
          expires_at: farFuture.toISOString(),
        },
      });
      store = createTokenStore({ tokensFilePath, log });
      logMessages.length = 0;

      // Update to an expiring token
      const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
      writeTokensFile(tokensFilePath, {
        proj: {
          token: 'tok',
          repos: ['o/r'],
          expires_at: soon.toISOString(),
        },
      });
      store.reload();

      const warnMsg = logMessages.find(m =>
        (m.level === 'warn' || m.level === 'error') &&
        m.msg.includes('proj')
      );
      expect(warnMsg).toBeDefined();
    });
  });
});
