/**
 * Credential token store derived from config — the single source of truth for
 * project PATs.
 *
 * Each repo's PAT comes from `config.json` `repos[].token` (an `ENV:` reference
 * resolved from the daemon's environment file). This store exposes those same
 * values through the {@link TokenStore} interface, so every PAT consumer — the
 * agent-socket relays (`push_branch`, `pr_create`, `pr_view`,
 * `github_http_forward`), webhook status comments, and `tokens status` — reads
 * the token the session spawn path already uses. `tokens.json` is not read.
 *
 * Scoping is unchanged from the file store: one project per configured repo,
 * holding only that repo. A repo without `token` has no entry, so lookups for it
 * fail closed; there is no fallback to `defaultGithubToken` or the ambient
 * `GITHUB_TOKEN` (security-isolation-fix FR-2).
 */
import { Secret } from './secret.js';
import type { ProjectEntry, TokenMap, TokenStore } from './token-store.js';

export interface ConfigTokenRepo {
  readonly owner: string;
  readonly name: string;
  readonly token?: string | undefined;
}

/** Project name for a repo: `<owner>/<name>` with `/` mapped to `__`. */
export function configProjectName(owner: string, name: string): string {
  return `${owner}__${name}`;
}

export function buildConfigTokenMap(repos: readonly ConfigTokenRepo[]): TokenMap {
  const projects = new Map<string, ProjectEntry>();
  const repoIndex = new Map<string, string>();
  for (const r of repos) {
    if (typeof r.token !== 'string' || r.token.length === 0) continue;
    const slug = `${r.owner}/${r.name}`;
    const projectName = configProjectName(r.owner, r.name);
    projects.set(projectName, {
      name: projectName,
      token: Secret.of(r.token),
      repos: [slug],
      expiresAt: undefined,
    });
    repoIndex.set(slug, projectName);
  }
  return { projects, repoIndex };
}

/** Same project set and token values (by revealed string), ignoring order. */
function sameMap(a: TokenMap, b: TokenMap): boolean {
  if (a.projects.size !== b.projects.size) return false;
  for (const [name, entry] of a.projects) {
    const other = b.projects.get(name);
    if (other === undefined || other.token.reveal() !== entry.token.reveal()) return false;
  }
  return true;
}

/**
 * @param getRepos returns the CURRENT config repos; `reload()` re-reads it, so
 *   call `reload()` after a config hot-reload to pick up rotated tokens.
 */
export function createConfigTokenStore(getRepos: () => readonly ConfigTokenRepo[]): TokenStore {
  let map = buildConfigTokenMap(getRepos());
  return {
    getToken(projectName: string) {
      return map.projects.get(projectName)?.token;
    },
    getProject(projectName: string) {
      return map.projects.get(projectName);
    },
    findProjectByRepo(repo: string) {
      return map.repoIndex.get(repo);
    },
    getTokenMap() {
      return map;
    },
    reload() {
      const next = buildConfigTokenMap(getRepos());
      if (sameMap(map, next)) return false;
      map = next;
      return true;
    },
    // Config hot-reload drives `reload()`; there is no file to watch.
    startWatching() {},
    stopWatching() {},
  };
}
