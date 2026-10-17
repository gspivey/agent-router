/**
 * Tier 1 tests: credentialTokenResolver (security-isolation-fix FR-2).
 *
 * The agent-socket PAT source resolves ONLY through the credential token store
 * (findProjectByRepo → getToken → reveal), with NO env fallback. A repo not
 * listed in any tokens.json project throws, so PAT-dependent ops fail closed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { credentialTokenResolver } from '../../src/token-resolver.js';
import { createTokenStore } from '../../src/token-store.js';
import type { TokenStore, TokenMap, ProjectEntry } from '../../src/token-store.js';
import { Secret } from '../../src/secret.js';
import type { Logger } from '../../src/log.js';

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
} as unknown as Logger;

/** Minimal in-memory TokenStore built from a project→(token,repos) map. */
function mockStore(projects: Record<string, { token: string; repos: string[] }>): TokenStore {
  const projectMap = new Map<string, ProjectEntry>();
  const repoIndex = new Map<string, string>();
  for (const [name, { token, repos }] of Object.entries(projects)) {
    projectMap.set(name, { name, token: Secret.of(token), repos, expiresAt: undefined });
    for (const r of repos) repoIndex.set(r, name);
  }
  const map: TokenMap = { projects: projectMap, repoIndex };
  return {
    getToken: (p) => projectMap.get(p)?.token,
    getProject: (p) => projectMap.get(p),
    findProjectByRepo: (r) => repoIndex.get(r),
    getTokenMap: () => map,
    reload: () => false,
    startWatching: () => {},
    stopWatching: () => {},
  };
}

const ORIG_TOKEN = process.env['GITHUB_TOKEN'];
beforeEach(() => {
  process.env['GITHUB_TOKEN'] = 'ghp_SENTINEL';
});
afterEach(() => {
  if (ORIG_TOKEN === undefined) delete process.env['GITHUB_TOKEN'];
  else process.env['GITHUB_TOKEN'] = ORIG_TOKEN;
});

describe('credentialTokenResolver', () => {
  it('resolves a stored project token for a repo in that project', () => {
    const resolve = credentialTokenResolver(
      mockStore({ proj: { token: 'tok-proj', repos: ['gspivey/agent-router'] } }),
    );
    expect(resolve('gspivey', 'agent-router')).toBe('tok-proj');
  });

  it('throws "No token configured" when the repo maps to no project', () => {
    const resolve = credentialTokenResolver(
      mockStore({ proj: { token: 'tok-proj', repos: ['gspivey/other'] } }),
    );
    expect(() => resolve('gspivey', 'agent-router')).toThrow(
      'No token configured for repo gspivey/agent-router',
    );
  });

  it('never falls back to process.env.GITHUB_TOKEN (sentinel never leaks)', () => {
    const resolve = credentialTokenResolver(mockStore({}));
    expect(() => resolve('o', 'r')).toThrow('No token configured for repo o/r');
    // Also assert a successful resolution returns the stored token, not the sentinel.
    const resolve2 = credentialTokenResolver(
      mockStore({ p: { token: 'tok-stored', repos: ['o/r'] } }),
    );
    expect(resolve2('o', 'r')).toBe('tok-stored');
    expect(resolve2('o', 'r')).not.toBe('ghp_SENTINEL');
  });

  it('picks up rotated tokens after store.reload() with no reassignment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-resolver-'));
    const file = path.join(dir, 'tokens.json');
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({ projects: { p: { token: 'tok-v1', repos: ['o/r'] } } }),
      );
      const store = createTokenStore({ tokensFilePath: file, log: silentLog });
      const resolve = credentialTokenResolver(store);
      expect(resolve('o', 'r')).toBe('tok-v1');

      fs.writeFileSync(
        file,
        JSON.stringify({ projects: { p: { token: 'tok-v2', repos: ['o/r'] } } }),
      );
      expect(store.reload()).toBe(true);
      // Same resolver instance returns the new token — reload mutates in place.
      expect(resolve('o', 'r')).toBe('tok-v2');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws for any repo in _fallback mode (no tokens.json)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-resolver-fb-'));
    const file = path.join(dir, 'tokens.json'); // does not exist
    try {
      const store = createTokenStore({ tokensFilePath: file, log: silentLog, fallbackToken: 'ghp_fb' });
      const resolve = credentialTokenResolver(store);
      expect(() => resolve('gspivey', 'agent-router')).toThrow(
        'No token configured for repo gspivey/agent-router',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
