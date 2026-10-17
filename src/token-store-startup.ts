/**
 * Token_Store startup validation.
 *
 * Pure validation functions for the daemon startup sequence. Extracted from
 * src/index.ts for direct Tier 1 testing.
 */

import { FatalError } from './errors.js';
import type { TokenStore } from './token-store.js';
import type { Logger } from './log.js';

/**
 * Validate Token_Store configuration at startup.
 *
 * Throws FatalError if the Token_Store is in fallback mode (using GITHUB_TOKEN
 * env var) and credentialMode is 'mcp'. In MCP mode, the daemon cannot provide
 * credentials through MCP tools without a properly configured tokens.json file.
 *
 * Requirements: 1.5, 4.4
 */
export function validateTokenStoreStartup(
  tokenStore: TokenStore,
  credentialMode: 'env' | 'mcp',
): void {
  // Fallback mode is detected by the presence of the synthetic '_fallback' project
  // created when tokens.json is missing and GITHUB_TOKEN is used instead.
  const isFallbackMode = tokenStore.getProject('_fallback') !== undefined;

  if (isFallbackMode && credentialMode === 'mcp') {
    throw new FatalError(
      'Cannot use credentialMode "mcp" without a tokens.json file. ' +
      'The MCP credential tools require project-scoped tokens configured in tokens.json. ' +
      'Either provide a tokens.json file or set credentialMode to "env" in config.json.'
    );
  }
}

/**
 * Advisory startup check for the agent-socket PAT source (security-isolation-fix
 * FR-2.4 / AC-10).
 *
 * After the credential-token-source fix, the agent server resolves PATs ONLY
 * through the credential token store ({@link credentialTokenResolver}) with no
 * env fallback. In `_fallback` mode (no tokens.json, only GITHUB_TOKEN set) the
 * synthetic `_fallback` project has an empty repo index, so `push_branch`,
 * `pr_create`, `pr_view`, and authenticated `github_http_forward` all fail
 * closed. This is the intended security outcome; the warning makes the
 * provisioning gap visible so operators create a tokens.json.
 *
 * Non-fatal: logs a WARNING and returns.
 */
export function checkAgentSocketTokenSource(tokenStore: TokenStore, log: Logger): void {
  if (tokenStore.getProject('_fallback') !== undefined) {
    log.warn(
      'tokens.json not found — agent-socket PAT operations (push_branch, pr_create, pr_view) ' +
      'require a tokens.json with project-scoped credentials',
      { hint: 'create tokens.json — see docs/security-setup.md' },
    );
  }
}
