/**
 * Tier 2 tests: webhook token reverse lookup via Token_Store.
 *
 * Exercises the `resolveWebhookToken` utility function that uses Token_Store's
 * reverse lookup (repo → project → PAT) for outgoing GitHub API calls.
 *
 * Requirements: 8.1, 8.2, 8.3
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveWebhookToken } from '../../src/server.js';
import { createTokenStore } from '../../src/token-store.js';
import type { TokenStore } from '../../src/token-store.js';
import type { Logger } from '../../src/log.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function makeLogger(): Logger & { warnings: Array<{ msg: string; fields: Record<string, unknown> }> } {
  const warnings: Array<{ msg: string; fields: Record<string, unknown> }> = [];
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: (msg: string, fields?: Record<string, unknown>) => {
      warnings.push({ msg, fields: fields ?? {} });
    },
    error: noop,
    child: () => makeLogger(),
    warnings,
  };
}

function createTempTokensFile(projects: Record<string, { token: string; repos: string[]; expires_at?: string }>): { filePath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-token-test-'));
  const filePath = path.join(tmpDir, 'tokens.json');
  fs.writeFileSync(filePath, JSON.stringify({ projects }), { mode: 0o600 });
  return {
    filePath,
    cleanup: () => { fs.rmSync(tmpDir, { recursive: true, force: true }); },
  };
}

describe('Tier 2: webhook token reverse lookup', () => {
  it('resolves correct project-scoped PAT for a known repo (Req 8.1, 8.2)', () => {
    const { filePath, cleanup } = createTempTokensFile({
      'my-project': {
        token: 'ghp_project_token_abc',
        repos: ['gspivey/agent-router', 'gspivey/other-repo'],
      },
      'another-project': {
        token: 'ghp_another_token_xyz',
        repos: ['org/repo-c'],
      },
    });

    try {
      const log = makeLogger();
      const tokenStore = createTokenStore({ tokensFilePath: filePath, log });

      // Reverse lookup for gspivey/agent-router should resolve to my-project's token
      const token = resolveWebhookToken('gspivey/agent-router', tokenStore, log);
      expect(token).toBeDefined();
      expect(token!.reveal()).toBe('ghp_project_token_abc');
      expect(log.warnings).toHaveLength(0);

      // Reverse lookup for org/repo-c should resolve to another-project's token
      const token2 = resolveWebhookToken('org/repo-c', tokenStore, log);
      expect(token2).toBeDefined();
      expect(token2!.reveal()).toBe('ghp_another_token_xyz');
      expect(log.warnings).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('logs warning and returns undefined for unknown repo (Req 8.3)', () => {
    const { filePath, cleanup } = createTempTokensFile({
      'my-project': {
        token: 'ghp_project_token_abc',
        repos: ['gspivey/agent-router'],
      },
    });

    try {
      const log = makeLogger();
      const tokenStore = createTokenStore({ tokensFilePath: filePath, log });

      const token = resolveWebhookToken('unknown-org/unknown-repo', tokenStore, log);
      expect(token).toBeUndefined();
      expect(log.warnings).toHaveLength(1);
      expect(log.warnings[0]!.msg).toContain('No project found');
      expect(log.warnings[0]!.fields['repo']).toBe('unknown-org/unknown-repo');
    } finally {
      cleanup();
    }
  });

  it('works in fallback mode with synthetic single-project entry (Req 8.1)', () => {
    // In fallback mode, the TokenStore has a synthetic _fallback project with empty repos[].
    // Since fallback repos[] is empty, reverse lookup for any specific repo will fail.
    // This tests the correct behavior: fallback mode cannot do reverse lookup for webhook repos
    // because the synthetic entry has no repos listed.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-token-fallback-'));
    const filePath = path.join(tmpDir, 'tokens.json');
    // Don't create the file — force fallback to GITHUB_TOKEN
    try {
      const log = makeLogger();
      const tokenStore = createTokenStore({
        tokensFilePath: filePath,
        log,
        fallbackToken: 'ghp_fallback_token_123',
      });

      // Fallback mode: reverse lookup returns undefined because repos[] is empty
      const token = resolveWebhookToken('gspivey/agent-router', tokenStore, log);
      expect(token).toBeUndefined();
      expect(log.warnings.some(w => w.msg.includes('No project found'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves token for each repo in a multi-repo project', () => {
    const { filePath, cleanup } = createTempTokensFile({
      'multi-repo': {
        token: 'ghp_multi_token',
        repos: ['org/repo-a', 'org/repo-b', 'org/repo-c'],
      },
    });

    try {
      const log = makeLogger();
      const tokenStore = createTokenStore({ tokensFilePath: filePath, log });

      // All three repos should resolve to the same token
      for (const repo of ['org/repo-a', 'org/repo-b', 'org/repo-c']) {
        const token = resolveWebhookToken(repo, tokenStore, log);
        expect(token).toBeDefined();
        expect(token!.reveal()).toBe('ghp_multi_token');
      }
      expect(log.warnings).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('never exposes token value in warning log messages', () => {
    const { filePath, cleanup } = createTempTokensFile({
      'secret-project': {
        token: 'ghp_super_secret_token_never_log_this',
        repos: ['org/known-repo'],
      },
    });

    try {
      const log = makeLogger();
      const tokenStore = createTokenStore({ tokensFilePath: filePath, log });

      // Resolve a known repo (succeeds — no warnings)
      const token = resolveWebhookToken('org/known-repo', tokenStore, log);
      expect(token).toBeDefined();

      // Resolve an unknown repo (warning logged)
      resolveWebhookToken('org/unknown-repo', tokenStore, log);

      // Check that no warning message contains the token value
      const tokenValue = 'ghp_super_secret_token_never_log_this';
      for (const w of log.warnings) {
        expect(w.msg).not.toContain(tokenValue);
        expect(JSON.stringify(w.fields)).not.toContain(tokenValue);
      }
    } finally {
      cleanup();
    }
  });
});
