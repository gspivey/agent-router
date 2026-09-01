/**
 * Credential validators — pure validation functions for MCP credential tools.
 *
 * These validators are used by the github_http_forward and git_credential MCP tool
 * handlers to validate incoming requests before processing.
 *
 * All functions are pure (no I/O, no side effects) and exported individually
 * for direct unit testing with fast-check property tests.
 */

/** Valid HTTP methods for github_http_forward. */
export const VALID_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ValidMethod = (typeof VALID_METHODS)[number];

/** Known GitHub API path prefixes. */
export const GITHUB_API_PREFIXES = [
  '/repos/',
  '/orgs/',
  '/users/',
  '/gists/',
  '/search/',
  '/notifications/',
  '/issues/',
  '/pulls/',
] as const;

/** Maximum request body size in bytes (10 MB). */
export const MAX_BODY_SIZE_BYTES = 10 * 1024 * 1024;

/** Write HTTP methods that require Bound_Project authorization. */
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

export interface ValidationError {
  code: string;
  message: string;
}

export interface RepoAuthorizationContext {
  boundProjectRepos: readonly string[];
  readRepos: readonly string[];
}

/**
 * Validate that the HTTP method is one of GET, POST, PUT, PATCH, DELETE.
 * Property 11: accepts iff method is one of the five valid methods.
 */
export function validateMethod(method: string): ValidationError | null {
  if ((VALID_METHODS as readonly string[]).includes(method)) return null;
  return {
    code: 'method_invalid',
    message: `Invalid HTTP method: ${method}. Must be one of: ${VALID_METHODS.join(', ')}`,
  };
}

/**
 * Validate that the path starts with a known GitHub API prefix.
 * Property 12: accepts iff path starts with one of the known prefixes.
 */
export function validatePathPrefix(path: string): ValidationError | null {
  for (const prefix of GITHUB_API_PREFIXES) {
    if (path.startsWith(prefix)) return null;
  }
  return {
    code: 'path_invalid',
    message: `Invalid GitHub API path: must start with one of ${GITHUB_API_PREFIXES.join(', ')}`,
  };
}

/**
 * Validate that the request body does not exceed 10 MB.
 * Property 13: rejects iff Buffer.byteLength(body) > 10 * 1024 * 1024.
 */
export function validateBodySize(body: string | undefined): ValidationError | null {
  if (body === undefined) return null;
  if (Buffer.byteLength(body) > MAX_BODY_SIZE_BYTES) {
    return { code: 'body_too_large', message: `Request body exceeds maximum size of 10 MB` };
  }
  return null;
}

/**
 * Ensure the owner/repo encoded in a github_http_forward path matches the
 * authorized repo argument, and that the path has no traversal/injection tricks.
 *
 * Requirement 5 (auth-credential-proxy-v2): authorization runs against the `repo`
 * argument, but the upstream URL is built from `path`. Without this cross-check an
 * agent authorized for `mine/allowed` could pass
 * `{ repo: "mine/allowed", path: "/repos/other/victim/contents/x" }` and write
 * `other/victim`.
 *
 * Algorithm:
 *  1. Strip the query string (`?...`) before any checks — the checks apply to the
 *     path component only.
 *  2. Reject `path_invalid` if the path component contains `..`, `//`, `://`, `@`,
 *     or any URL-encoded dot sequence (`%2e`/`%2E`, case-insensitive). These checks
 *     run on the raw string to prevent WHATWG URL normalization from turning
 *     `%2e%2e` into `..` after validation.
 *  3. If no `/repos/{owner}/{repo}` segment is present, return null — non-repo paths
 *     (`/search/`, `/orgs/`, `/users/`, …) do not target a specific repo and are
 *     already gated by `validateRepoAuthorization` on the `repo` argument.
 *  4. Extract the first `{owner}/{repo}` following `repos`, lowercase both it and
 *     `repo`, and reject `repo_unauthorized` on mismatch.
 *  5. Otherwise return null.
 */
export function validatePathMatchesRepo(path: string, repo: string): ValidationError | null {
  // 1. Strip query string — checks apply to the path component only.
  const pathComponent = path.split('?')[0] ?? '';

  // 2. Reject traversal / injection tricks on the raw string (pre-normalization).
  const lowered = pathComponent.toLowerCase();
  if (
    pathComponent.includes('..') ||
    pathComponent.includes('//') ||
    pathComponent.includes('://') ||
    pathComponent.includes('@') ||
    lowered.includes('%2e')
  ) {
    return {
      code: 'path_invalid',
      message: `Invalid GitHub API path: path contains a traversal or injection sequence`,
    };
  }

  // 3. Find the first `/repos/{owner}/{repo}` segment.
  const segments = pathComponent.split('/').filter((s) => s.length > 0);
  const reposIdx = segments.indexOf('repos');
  if (reposIdx === -1 || segments.length < reposIdx + 3) {
    // No repo-scoped path — no cross-check needed.
    return null;
  }

  // 4. Extract owner/repo and compare case-insensitively.
  const owner = segments[reposIdx + 1]!;
  const name = segments[reposIdx + 2]!;
  const pathRepo = `${owner}/${name}`.toLowerCase();
  if (pathRepo !== repo.toLowerCase()) {
    return {
      code: 'repo_unauthorized',
      message: `Path targets repository "${owner}/${name}" but the authorized repo is "${repo}". The path's owner/repo must match the repo argument.`,
    };
  }

  // 5. Match.
  return null;
}

/**
 * Validate repo authorization.
 * Property 6: For write methods (POST, PUT, PATCH, DELETE), the repo must be in boundProjectRepos.
 * For read methods (GET), the repo must be in boundProjectRepos OR in readRepos.
 */
export function validateRepoAuthorization(
  method: string,
  repo: string,
  ctx: RepoAuthorizationContext,
): ValidationError | null {
  const isWriteMethod = (WRITE_METHODS as readonly string[]).includes(method);

  if (isWriteMethod) {
    // Write methods: repo must be in Bound_Project repos
    if (!ctx.boundProjectRepos.includes(repo)) {
      return {
        code: 'repo_unauthorized',
        message: `Repository "${repo}" is not in the bound project's repo list. Write operations are only permitted for repos in the bound project.`,
      };
    }
    return null;
  }

  // Read methods (GET): allowed if in boundProjectRepos OR in readRepos
  if (ctx.boundProjectRepos.includes(repo)) return null;
  if (ctx.readRepos.includes(repo)) return null;

  return {
    code: 'repo_unauthorized',
    message: `Repository "${repo}" is not authorized for read access. It must be in the bound project's repos or declared in read_repos.`,
  };
}
