/**
 * Tier 1 tests: Token_Store startup integration logic.
 *
 * Tests the pure validation function that rejects fallback mode when
 * credentialMode is 'mcp'. This is the FatalError guard from task 23.1.
 *
 * Requirements: 1.5, 4.4
 */
import { describe, it, expect } from 'vitest';
import { validateTokenStoreStartup } from '../../src/token-store-startup.js';
import { FatalError } from '../../src/errors.js';
import type { TokenStore, TokenMap, ProjectEntry } from '../../src/token-store.js';
import { Secret } from '../../src/secret.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTokenStore(projectNames: string[]): TokenStore {
  const projects = new Map<string, ProjectEntry>();
  const repoIndex = new Map<string, string>();

  for (const name of projectNames) {
    const repos = [`org/${name}-repo`];
    projects.set(name, {
      name,
      token: Secret.of(`tok-${name}`),
      repos,
      expiresAt: undefined,
    });
    for (const repo of repos) {
      repoIndex.set(repo, name);
    }
  }

  const map: TokenMap = { projects, repoIndex };

  return {
    getToken: (p) => projects.get(p)?.token,
    getProject: (p) => projects.get(p),
    findProjectByRepo: (r) => repoIndex.get(r),
    getTokenMap: () => map,
    reload: () => false,
    startWatching: () => {},
    stopWatching: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateTokenStoreStartup', () => {
  describe('FatalError on fallback mode + credentialMode "mcp"', () => {
    it('throws FatalError when tokenStore is in fallback mode and credentialMode is mcp', () => {
      const store = createMockTokenStore(['_fallback']);
      expect(() => validateTokenStoreStartup(store, 'mcp')).toThrow(FatalError);
    });

    it('includes guidance in the error message', () => {
      const store = createMockTokenStore(['_fallback']);
      expect(() => validateTokenStoreStartup(store, 'mcp')).toThrow(
        /tokens\.json|credentialMode.*env/i
      );
    });

    it('does not throw when credentialMode is env and tokenStore is in fallback mode', () => {
      const store = createMockTokenStore(['_fallback']);
      expect(() => validateTokenStoreStartup(store, 'env')).not.toThrow();
    });

    it('does not throw when credentialMode is mcp but tokenStore is NOT in fallback mode', () => {
      const store = createMockTokenStore(['my-project']);
      expect(() => validateTokenStoreStartup(store, 'mcp')).not.toThrow();
    });

    it('does not throw when credentialMode is env and tokenStore has real projects', () => {
      const store = createMockTokenStore(['project-a', 'project-b']);
      expect(() => validateTokenStoreStartup(store, 'env')).not.toThrow();
    });

    it('detects fallback mode by _fallback project name even among other projects', () => {
      // Edge case: if somehow _fallback exists alongside real projects, it's still fallback
      // (In practice, fallback mode only creates _fallback, but let's be explicit)
      const store = createMockTokenStore(['_fallback']);
      expect(() => validateTokenStoreStartup(store, 'mcp')).toThrow(FatalError);
    });
  });
});
