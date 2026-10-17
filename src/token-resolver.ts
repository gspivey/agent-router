import type { TokenResolver } from './github.js';
import type { TokenStore } from './token-store.js';

/**
 * Build a {@link TokenResolver} backed exclusively by the credential token
 * store — with NO environment fallback (security-isolation-fix FR-2).
 *
 * This is the token source for the agent server's credential-boundary ops
 * (`push_branch`, `pr_create`, `pr_view`, authenticated `github_http_forward`).
 * It resolves `owner/repo` → project (via `findProjectByRepo`) → PAT (via
 * `getToken`) → `reveal()`, and THROWS `No token configured for repo <slug>`
 * when either lookup is absent. A repo not listed in any `tokens.json` project
 * therefore fails closed instead of silently falling back to the daemon's
 * ambient `GITHUB_TOKEN` (agent-process-isolation design §H, push_branch step 6).
 *
 * The store is captured by reference: `store.reload()` swaps its internal map
 * in place, so later calls transparently pick up rotated tokens — no extra
 * indirection and no reassignment is required at the call site.
 */
export function credentialTokenResolver(store: TokenStore): TokenResolver {
  return (owner: string, repo: string): string => {
    const slug = `${owner}/${repo}`;
    const projectName = store.findProjectByRepo(slug);
    const secret = projectName !== undefined ? store.getToken(projectName) : undefined;
    if (secret === undefined) {
      throw new Error(`No token configured for repo ${slug}`);
    }
    return secret.reveal();
  };
}
