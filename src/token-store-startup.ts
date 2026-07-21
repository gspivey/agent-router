/**
 * Token_Store startup validation.
 *
 * Pure validation functions for the daemon startup sequence. Extracted from
 * src/index.ts for direct Tier 1 testing.
 */

import { FatalError } from './errors.js';
import type { TokenStore } from './token-store.js';

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
