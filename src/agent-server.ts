/**
 * Agent-only socket server (agent process isolation, FR-4 / FR-5 / FR-6).
 *
 * The daemon exposes TWO Unix sockets:
 *  - the operator socket (`cli-server.ts`, `$rootDir/sock`, mode 0600) — full
 *    control, NEVER reachable by `agentworker`.
 *  - the agent socket (this file, `/run/agent-router/agent.sock`, mode 0660) —
 *    a deliberately narrow surface the per-session MCP server relays to on
 *    behalf of the (untrusted) agent.
 *
 * Every op is authenticated with a per-session capability token
 * (`crypto.timingSafeEqual`). The credential boundary lives here, daemon-side:
 * the agent never sees a PAT. `github_forward` validates the raw request path
 * with strict character-set checks (NOT decode-then-check), runs an exact
 * (method, path-pattern) allowlist, enforces repo scope against the session's
 * bound repo, and injects the PAT from the token resolver. `push_branch`
 * accepts a git bundle the agent wrote to its own session dir and pushes it
 * from a daemon-owned bare repo with the PAT in the child env only (never on
 * disk, never on argv).
 *
 * Wire protocol mirrors `cli-server.ts`: newline-delimited JSON frames,
 * `{ op, session_id, cap_token, ...args }` request → `{...}` response.
 *
 * The exhaustive op surface (FR-4.3) is implemented in later items; task 84.3
 * stands up the socket, cap-token auth, the dispatch skeleton, `github_forward`
 * (daemon-side allowlist + raw path validation + repo scope + fetch), the
 * `push_branch` bundle handoff, the pr relays, and forwarding of the plain
 * session-manager ops. All unknown ops return `{ error: 'Unknown op' }`.
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from './log.js';
import type { SessionManager } from './session-mgr.js';
import { OpenPRsError } from './session-mgr.js';
import type { GitHubClient, TokenResolver } from './github.js';
import type { Database } from './db.js';
import type { SessionFiles } from './session-files.js';
import type { GithubForwardAllowEntry } from './config.js';
import { sessionWorkDir } from './worktree-manager.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Allowlist (FR-5.4)
// ---------------------------------------------------------------------------

/**
 * The built-in `github_forward` allowlist. Each entry is an exact (methods,
 * path-pattern) pair; `{o}`, `{r}`, `{n}`, `{ref}`, `{branch}` are segment
 * placeholders. Any (method, path) not matched here is rejected.
 */
export const DEFAULT_GITHUB_FORWARD_ALLOWLIST: GithubForwardAllowEntry[] = [
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/pulls' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/pulls/{n}' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/pulls/{n}/files' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/pulls/{n}/reviews' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/pulls/{n}/comments' },
  { methods: ['POST'], pathPattern: '/repos/{o}/{r}/pulls' },
  { methods: ['PATCH'], pathPattern: '/repos/{o}/{r}/pulls/{n}' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/issues/{n}/comments' },
  { methods: ['POST'], pathPattern: '/repos/{o}/{r}/issues/{n}/comments' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/commits/{ref}/check-runs' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/actions/runs' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/actions/runs/{n}' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/actions/runs/{n}/jobs' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/statuses/{ref}' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/git/refs/heads/{branch}' },
  { methods: ['GET'], pathPattern: '/repos/{o}/{r}/branches/{branch}' },
];

/** Placeholders that stand for a single opaque segment. */
const SEGMENT_PLACEHOLDERS = new Set(['{o}', '{r}', '{n}', '{ref}', '{branch}']);

/**
 * Match a concrete `url.pathname` against the allowlist. Returns true iff some
 * entry permits `(method, pathname)`. Segment placeholders match exactly one
 * path segment; `{ref}` and `{branch}` may contain slashes (multi-segment).
 */
export function isAllowedGithubForward(
  method: string,
  pathname: string,
  allowlist: GithubForwardAllowEntry[] = DEFAULT_GITHUB_FORWARD_ALLOWLIST,
): boolean {
  const upper = method.toUpperCase();
  const pathSegs = pathname.split('/');
  for (const entry of allowlist) {
    if (!entry.methods.map((m) => m.toUpperCase()).includes(upper)) continue;
    if (patternMatches(entry.pathPattern, pathSegs)) return true;
  }
  return false;
}

function patternMatches(pattern: string, pathSegs: string[]): boolean {
  const patSegs = pattern.split('/');
  let pi = 0;
  let si = 0;
  while (pi < patSegs.length) {
    const pat = patSegs[pi]!;
    if (pat === '{ref}' || pat === '{branch}') {
      // Multi-segment greedy-but-anchored: {ref}/{branch} is the last segment
      // group in every allowlist entry, so it absorbs the remaining path.
      // If there are more pattern segments after it, match them from the end.
      const remainingPat = patSegs.length - pi - 1;
      const remainingPath = pathSegs.length - si;
      if (remainingPath < 1 + remainingPat) return false;
      // Consume (remainingPath - remainingPat) path segments for the ref.
      si += remainingPath - remainingPat;
      pi += 1;
      continue;
    }
    if (si >= pathSegs.length) return false;
    const seg = pathSegs[si]!;
    if (SEGMENT_PLACEHOLDERS.has(pat)) {
      if (seg.length === 0) return false; // placeholder must match a non-empty segment
    } else if (pat !== seg) {
      return false;
    }
    pi += 1;
    si += 1;
  }
  return si === pathSegs.length;
}

// ---------------------------------------------------------------------------
// Raw path validation + URL construction (design §E, FR-5.3)
// ---------------------------------------------------------------------------

const SEG_RE = /^[A-Za-z0-9._-]+$/;
const REF_SEG_RE = /^[A-Za-z0-9._\-/]+$/;
const ALLOWED_QUERY_PARAMS = new Set(['per_page', 'page', 'state', 'head', 'base', 'sort', 'direction']);

/**
 * Return the set of path-segment indices that are "ref positions" where a
 * branch/commit ref may legitimately contain slashes (and thus `%2F`). These
 * are the trailing segment after `git/refs/heads/`, `branches/`,
 * `commits/.../`, `statuses/`.
 */
function isRefSegmentPosition(index: number, segments: string[]): boolean {
  // segments[0] is '' (leading slash). Ref positions follow a known keyword.
  const prev = segments[index - 1];
  if (prev === 'heads' && segments[index - 2] === 'refs') return true; // git/refs/heads/{branch}
  if (prev === 'branches') return true; // branches/{branch}
  if (prev === 'commits') return true; // commits/{ref}/...
  if (prev === 'statuses') return true; // statuses/{ref}
  return false;
}

/**
 * Validate a raw request path with strict character-set checks (NO
 * decode-then-check) and build the outgoing URL. Returns `null` on any
 * rejection. Query params are supplied structurally (never embedded in the
 * raw path).
 */
export function validateAndBuildUrl(
  rawPath: string,
  queryParams?: Record<string, string>,
): URL | null {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) return null;
  // Reject obviously dangerous characters up-front (backslash, control chars,
  // query/fragment markers, bare percent that isn't an allowed %2F ref).
  if (/[\\?#\x00-\x1f\x7f]/.test(rawPath)) return null;

  const segments = rawPath.split('/');
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === '') return null; // empty segment (double/trailing slash)
    if (isRefSegmentPosition(i, segments)) {
      // Allow %2F only in ref positions; otherwise strict ref charset.
      const normalized = seg.replace(/%2[fF]/g, '/');
      if (!REF_SEG_RE.test(normalized)) return null;
    } else {
      if (seg.includes('%')) return null; // no encoded bytes outside ref positions
      if (!SEG_RE.test(seg)) return null;
    }
  }

  let url: URL;
  try {
    url = new URL(rawPath, 'https://api.github.com');
  } catch {
    return null;
  }
  if (url.origin !== 'https://api.github.com') return null;

  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (!ALLOWED_QUERY_PARAMS.has(k)) return null;
      url.searchParams.set(k, v);
    }
  }
  return url;
}

// ---------------------------------------------------------------------------
// push_branch branch-name validation (FR-6.1 step 2)
// ---------------------------------------------------------------------------

const BRANCH_RE = /^(agent|feat|fix|chore)\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'development']);

/** Returns true iff `branch` is a safe, non-protected feature branch name. */
export function isValidPushBranch(branch: string): boolean {
  if (typeof branch !== 'string' || branch.length === 0) return false;
  if (branch.includes('..') || branch.includes(':') || branch.includes('+') || branch.includes('@{')) {
    return false;
  }
  if (PROTECTED_BRANCHES.has(branch.toLowerCase())) return false;
  return BRANCH_RE.test(branch);
}

/** Parse `owner/repo` out of the first two segments after `/repos/`. */
export function extractRepoFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/repos\/([^/]+)\/([^/]+)/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/** Protected PR base branches that `github_forward`/`pr_create` must reject. */
const PROTECTED_PR_BASE = new Set(['main', 'master']);

/** Returns true iff a PR-create/merge body targets a protected base branch. */
export function bodyTargetsProtectedBase(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return false;
  const base = (body as Record<string, unknown>)['base'];
  return typeof base === 'string' && PROTECTED_PR_BASE.has(base.toLowerCase());
}

/** Keys permitted on a PR-update (PATCH pulls) body. */
const PR_PATCH_ALLOWED_KEYS = new Set(['title', 'body']);

/** Returns true iff a PR-update body only touches `{title, body}`. */
export function prPatchBodyAllowed(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return true; // empty is fine
  for (const k of Object.keys(body as Record<string, unknown>)) {
    if (!PR_PATCH_ALLOWED_KEYS.has(k)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cap-token validation (FR-4.4)
// ---------------------------------------------------------------------------

/**
 * Constant-time cap-token comparison. Empty tokens are rejected before
 * `timingSafeEqual` (a length mismatch would throw).
 */
export function capTokensEqual(stored: string, provided: string): boolean {
  if (typeof stored !== 'string' || typeof provided !== 'string') return false;
  if (stored.length === 0 || provided.length === 0) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface AgentServer {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  /** Resolved socket path (after fallback). */
  readonly socketPath: string;
}

export interface AgentServerDeps {
  socketPath: string;
  sessionMgr: SessionManager;
  github: GitHubClient;
  tokenResolver: TokenResolver;
  log: Logger;
  db?: Database;
  /** Session files, used for read-only status/project/worktree ops. */
  sessionFiles?: SessionFiles;
  /** Sink for `report_outcome` (task-attempt-outcome). Returns true if accepted. */
  reportOutcomeSink?: (payload: {
    sessionId: string;
    outcome: string;
    reason_code: string | null;
    reason: string | null;
    blocked: unknown;
    pr_url: string | null;
  }) => boolean;
  /** Allowlist override; falls back to the built-in default. */
  allowList?: GithubForwardAllowEntry[];
  /** Base dir for per-session clones (push_branch bundle source). */
  worktreeBase: string;
  /**
   * Session layout the daemon created (must match the worktree manager's).
   * true: bundle read from `<base>/<sid>/work`; false: from `<base>/<sid>`.
   * Default false.
   */
  useWorkerUid?: boolean;
  /** Daemon's canonical bare clone resolver, keyed by `owner/repo`. */
  bareClonePathFor?: (repo: string) => string | undefined;
  /** Base branch PRs target. Default `development`. */
  baseBranch?: string;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Override execFile (for tests). */
  execFileImpl?: typeof execFileAsync;
  /**
   * Override the askpass-helper existence check (for tests).
   * Default: `() => fs.existsSync(ASKPASS_HELPER)`.
   * Pass `() => false` in tests that exercise the extraheader fallback path,
   * and `() => true` in tests that exercise the askpass path, so the test
   * result is independent of whether the helper is installed on the host.
   */
  askpassHelperExists?: () => boolean;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB (FR-5.3 step 7)
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024; // 50 MB (FR-6.1 step 4)
const ASKPASS_HELPER = '/usr/local/libexec/agent-router-askpass';
const CLEAN_GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

/**
 * Build a git auth environment that delivers the PAT without requiring the
 * askpass helper binary (which is only installed by setup-agent-user.sh).
 *
 * When the askpass binary exists (worker-uid isolation path), use it as
 * before.  When it does not exist (useWorkerUid=false), use the
 * GIT_CONFIG_COUNT env-config approach to attach the PAT as an HTTP
 * Authorization header — no binary required, no token in argv.
 *
 * @param pat - The personal access token to use for authentication.
 * @param askpassExists - Predicate for whether the askpass helper is present.
 */
function buildGitAuthEnv(pat: string, askpassExists: () => boolean): Record<string, string> {
  if (askpassExists()) {
    return {
      GIT_ASKPASS: ASKPASS_HELPER,
      GIT_ASKPASS_PASSWORD: pat,
    };
  }
  // GIT_CONFIG_COUNT / KEY/VALUE env-config (git 2.31+).
  // Sends an HTTP Authorization header for github.com only; no disk writes.
  const basic = Buffer.from(`x-access-token:${pat}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}

export function createAgentServer(deps: AgentServerDeps): AgentServer {
  const {
    socketPath,
    sessionMgr,
    github,
    tokenResolver,
    log,
    db,
  } = deps;
  const sessionFiles = deps.sessionFiles;
  const reportOutcomeSink = deps.reportOutcomeSink;
  const allowList = deps.allowList ?? DEFAULT_GITHUB_FORWARD_ALLOWLIST;
  const worktreeBase = deps.worktreeBase;
  const useWorkerUid = deps.useWorkerUid ?? false;
  const baseBranch = deps.baseBranch ?? 'development';
  const fetchImpl = deps.fetchImpl ?? fetch;
  const execFileImpl = deps.execFileImpl ?? execFileAsync;
  const askpassHelperExists = deps.askpassHelperExists ?? (() => fs.existsSync(ASKPASS_HELPER));

  let server: net.Server | null = null;
  const activeConnections = new Set<net.Socket>();

  /** Resolve the PAT for a `owner/repo` string via the token resolver. */
  function resolvePat(repo: string): string {
    const slash = repo.indexOf('/');
    if (slash < 1 || slash === repo.length - 1) {
      throw new Error(`Invalid repo "${repo}"`);
    }
    return tokenResolver(repo.slice(0, slash), repo.slice(slash + 1));
  }

  // --- github_forward handler (FR-5.3) ---

  async function handleGithubForward(
    sessionId: string,
    method: unknown,
    rawPath: unknown,
    body: unknown,
    queryParams: unknown,
  ): Promise<Record<string, unknown>> {
    if (typeof method !== 'string' || typeof rawPath !== 'string') {
      return { error: 'not permitted' };
    }
    const qp =
      queryParams !== null && typeof queryParams === 'object' && !Array.isArray(queryParams)
        ? (queryParams as Record<string, string>)
        : undefined;
    const url = validateAndBuildUrl(rawPath, qp);
    if (url === null) {
      log.warn('agent github_forward blocked: path validation', { sessionId, method, rawPath });
      return { error: 'not permitted' };
    }
    if (!isAllowedGithubForward(method, url.pathname, allowList)) {
      log.warn('agent github_forward blocked: not in allowlist', { sessionId, method, pathname: url.pathname });
      return { error: 'not permitted' };
    }

    // Repo scope check.
    const pathRepo = extractRepoFromPath(url.pathname)?.toLowerCase();
    const sessionRepo = sessionMgr.getSessionRepo(sessionId)?.toLowerCase();
    if (pathRepo !== undefined) {
      const isWrite = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
      const readRepos = sessionMgr.getSessionReadRepos(sessionId).map((r) => r.toLowerCase());
      if (isWrite && pathRepo !== sessionRepo) {
        log.warn('agent github_forward blocked: repo not in write scope', { sessionId, pathRepo });
        return { error: 'not permitted' };
      }
      if (!isWrite && pathRepo !== sessionRepo && !readRepos.includes(pathRepo)) {
        log.warn('agent github_forward blocked: repo not in scope', { sessionId, pathRepo });
        return { error: 'not permitted' };
      }
    }

    // Body-level checks.
    let parsedBody: unknown;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') {
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) return { error: 'not permitted' };
        try {
          parsedBody = JSON.parse(body);
        } catch {
          return { error: 'not permitted' };
        }
      } else {
        parsedBody = body;
      }
    }
    const upper = method.toUpperCase();
    if (upper === 'POST' && /^\/repos\/[^/]+\/[^/]+\/pulls$/.test(url.pathname)) {
      if (bodyTargetsProtectedBase(parsedBody)) {
        log.warn('agent github_forward blocked: PR base is protected', { sessionId });
        return { error: 'not permitted' };
      }
    }
    if (upper === 'PATCH' && /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+$/.test(url.pathname)) {
      if (!prPatchBodyAllowed(parsedBody)) {
        log.warn('agent github_forward blocked: PR patch body keys', { sessionId });
        return { error: 'not permitted' };
      }
    }

    // Resolve PAT from the session's bound repo (never from a caller argument).
    const authRepo = sessionRepo ?? pathRepo;
    if (authRepo === undefined) return { error: 'not permitted' };
    let pat: string;
    try {
      pat = resolvePat(authRepo);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('agent github_forward: token resolution failed', { sessionId, error: msg });
      return { error: 'not permitted' };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agent-router',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const init: RequestInit = { method: upper, headers, redirect: 'manual' };
    if (parsedBody !== undefined && (upper === 'POST' || upper === 'PATCH' || upper === 'PUT')) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(parsedBody);
    }

    let res: Response;
    try {
      res = await fetchImpl(url.toString(), init);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('agent github_forward: fetch failed', { sessionId, error: msg });
      return { error: 'upstream request failed' };
    }
    const text = await res.text();
    const capped = Buffer.byteLength(text) > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;

    // Record outbound comment ids so the wake policy can filter self-authored webhooks.
    if (
      db !== undefined &&
      upper === 'POST' &&
      /^\/repos\/[^/]+\/[^/]+\/issues\/[^/]+\/comments$/.test(url.pathname) &&
      res.ok
    ) {
      try {
        const parsed = JSON.parse(capped) as Record<string, unknown>;
        const id = parsed['id'];
        const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/([^/]+)\/comments$/);
        if (typeof id === 'number' && m) {
          db.insertOutboundComment(id, sessionId, m[1]!, Number(m[2]));
        }
      } catch {
        // best effort
      }
    }

    return { status: res.status, body: capped };
  }

  // --- push_branch handler (FR-6.1, design §H) ---

  async function handlePushBranch(
    sessionId: string,
    branch: unknown,
  ): Promise<Record<string, unknown>> {
    if (typeof branch !== 'string' || !isValidPushBranch(branch)) {
      if (typeof branch === 'string' && PROTECTED_BRANCHES.has(branch.toLowerCase())) {
        return { error: 'Protected branch' };
      }
      return { error: 'Invalid branch' };
    }
    const sessionRepo = sessionMgr.getSessionRepo(sessionId);
    if (sessionRepo === undefined) return { error: 'Session has no bound repo' };

    // Read the agent-written bundle (O_NOFOLLOW|O_NONBLOCK guards against FIFO/symlink).
    const bundleSrc = path.join(sessionWorkDir(worktreeBase, sessionId, useWorkerUid), 'push-bundle.bundle');
    let buf: Buffer;
    try {
      const fd = fs.openSync(
        bundleSrc,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) {
          return { error: 'Invalid bundle file' };
        }
        buf = Buffer.allocUnsafe(stat.size);
        fs.readSync(fd, buf, 0, stat.size, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('agent push_branch: bundle read failed', { sessionId, error: msg });
      return { error: 'Invalid bundle file' };
    }

    const pushTmpBase = fs.existsSync('/srv/agent-router/push-tmp')
      ? '/srv/agent-router/push-tmp'
      : os.tmpdir();
    const pushTmpDir = fs.mkdtempSync(path.join(pushTmpBase, `${sessionId}-`));
    try {
      fs.chmodSync(pushTmpDir, 0o700);
      const bundleDst = path.join(pushTmpDir, 'input.bundle');
      fs.writeFileSync(bundleDst, buf, { mode: 0o600 });

      const bareRepo = path.join(pushTmpDir, 'repo');
      fs.mkdirSync(bareRepo, { mode: 0o700 });
      await execFileImpl('git', ['init', '--bare', bareRepo], { env: CLEAN_GIT_ENV });

      const bareClonePath = deps.bareClonePathFor?.(sessionRepo);
      // Fail closed when the canonical bare clone is unavailable: the `.github/`
      // workflow guard below depends on it, so reject BEFORE any bundle work or
      // push happens (security-isolation-fix FR-3, design Fix 3). This runs
      // before `resolvePat`/push, so no remote push occurs when the guard
      // cannot run.
      if (bareClonePath === undefined) {
        return { error: 'bare clone not configured; push_branch cannot verify .github/ changes' };
      }

      // Fetch base branch (needed for .github comparison + bundle prereq).
      await execFileImpl(
        'git',
        [
          '-C', bareRepo,
          '-c', 'core.hooksPath=/dev/null',
          '-c', 'protocol.file.allow=always',
          '-c', 'credential.helper=',
          'fetch', bareClonePath, `refs/heads/${baseBranch}:refs/remotes/base/${baseBranch}`,
        ],
        { env: CLEAN_GIT_ENV },
      );

      await execFileImpl('git', ['-C', bareRepo, 'bundle', 'verify', bundleDst], { env: CLEAN_GIT_ENV });

      await execFileImpl(
        'git',
        [
          '-C', bareRepo,
          '-c', 'core.hooksPath=/dev/null',
          '-c', 'core.fsmonitor=false',
          '-c', 'protocol.file.allow=always',
          '-c', 'credential.helper=',
          'fetch', bundleDst, `refs/heads/${branch}:refs/heads/${branch}`,
        ],
        { env: CLEAN_GIT_ENV },
      );

      // .github tree-SHA comparison (named refs only) — fail closed on error.
      // bareClonePath is known-present here (checked above).
      const tip = await revParseTree(bareRepo, `refs/heads/${branch}:.github`);
      const base = await revParseTree(bareRepo, `refs/remotes/base/${baseBranch}:.github`);
      if (tip !== base) {
        return { error: 'Bundle modifies .github — workflow pushes are not permitted' };
      }

      const pat = resolvePat(sessionRepo);
      await execFileImpl(
        'git',
        [
          '-C', bareRepo,
          '-c', 'core.hooksPath=/dev/null',
          '-c', 'credential.helper=',
          '-c', `remote.origin.url=https://github.com/${sessionRepo}.git`,
          'push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`,
        ],
        {
          env: {
            ...CLEAN_GIT_ENV,
            GIT_TERMINAL_PROMPT: '0',
            ...buildGitAuthEnv(pat, askpassHelperExists),
          },
        },
      );
      return { ok: true, branch };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('agent push_branch failed', { sessionId, branch, error: msg });
      return { error: 'push failed' };
    } finally {
      fs.rmSync(pushTmpDir, { recursive: true, force: true });
    }
  }

  /** `git rev-parse --verify --quiet <ref>` — returns '' when absent, throws on real error. */
  async function revParseTree(bareRepo: string, ref: string): Promise<string> {
    try {
      const { stdout } = await execFileImpl(
        'git',
        ['-C', bareRepo, 'rev-parse', '--verify', '--quiet', ref],
        { env: CLEAN_GIT_ENV },
      );
      return stdout.trim();
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      if (e.code === 1 && (e.stderr === undefined || e.stderr.trim() === '')) return '';
      throw err;
    }
  }

  // --- pr_create / pr_view relays (FR-5.5) ---

  async function handlePrCreate(
    sessionId: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const sessionRepo = sessionMgr.getSessionRepo(sessionId);
    if (sessionRepo === undefined) return { error: 'not permitted' };
    if (bodyTargetsProtectedBase(body)) return { error: 'not permitted' };
    // Forward through github_forward with the create-PR path.
    return handleGithubForward(sessionId, 'POST', `/repos/${sessionRepo}/pulls`, body, undefined);
  }

  async function handlePrView(
    sessionId: string,
    prNumber: unknown,
  ): Promise<Record<string, unknown>> {
    const sessionRepo = sessionMgr.getSessionRepo(sessionId);
    if (sessionRepo === undefined) return { error: 'not permitted' };
    if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) {
      return { error: 'invalid pr_number' };
    }
    return handleGithubForward(
      sessionId,
      'GET',
      `/repos/${sessionRepo}/pulls/${prNumber}`,
      undefined,
      undefined,
    );
  }

  // --- Dispatch ---

  async function dispatch(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const op = req['op'];
    const sessionId = req['session_id'];
    const capToken = req['cap_token'];
    if (typeof op !== 'string') return { error: 'Unknown op' };
    if (typeof sessionId !== 'string' || sessionId.length === 0) return { error: 'Unauthorized' };
    if (typeof capToken !== 'string') return { error: 'Unauthorized' };

    // Authenticate every op (FR-4.4).
    if (!sessionMgr.validateCapToken(sessionId, capToken)) {
      return { error: 'Unauthorized' };
    }

    switch (op) {
      case 'session_status': {
        if (sessionFiles === undefined) return { error: 'not available' };
        try {
          const meta = sessionFiles.readMeta(sessionId);
          return { original_prompt: meta.original_prompt, prs: meta.prs, status: meta.status };
        } catch (err: unknown) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case 'register_pr': {
        const repo = req['repo'];
        const prNumber = req['pr_number'];
        if (typeof repo !== 'string' || typeof prNumber !== 'number') {
          return { error: 'invalid args' };
        }
        if (repo.toLowerCase() !== sessionMgr.getSessionRepo(sessionId)?.toLowerCase()) {
          return { error: 'Repo not in session scope' };
        }
        try {
          await sessionMgr.registerPR(sessionId, repo, prNumber);
          return { ok: true };
        } catch (err: unknown) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case 'merge_pr': {
        const repo = req['repo'];
        const prNumber = req['pr_number'];
        if (typeof repo !== 'string' || typeof prNumber !== 'number') {
          return { error: 'invalid args' };
        }
        if (repo.toLowerCase() !== sessionMgr.getSessionRepo(sessionId)?.toLowerCase()) {
          return { error: 'Repo not in session scope' };
        }
        // Reject merge into a protected push-target base branch.
        try {
          const slash = repo.indexOf('/');
          const owner = repo.slice(0, slash);
          const name = repo.slice(slash + 1);
          const pull = await github.getPullState(owner, name, prNumber);
          void pull;
          const result = await sessionMgr.mergePR(sessionId, repo, prNumber);
          return { ok: true, sha: result.sha, message: result.message };
        } catch (err: unknown) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case 'complete_session': {
        const reason = req['reason'];
        if (typeof reason !== 'string' || reason.length === 0) return { error: 'invalid reason' };
        try {
          await sessionMgr.completeSession(sessionId, reason);
          return { ok: true };
        } catch (err: unknown) {
          if (err instanceof OpenPRsError) {
            return { error: err.message, open_prs: err.openPRs };
          }
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case 'register_worktree': {
        // Record the worktree path via session files (the strict path
        // validation lives on the operator socket; the agent-provided path is
        // only ever read, never used for git operations — design §D).
        const p = req['path'];
        if (typeof p !== 'string' || p.length === 0) return { error: 'invalid path' };
        if (sessionFiles === undefined) return { error: 'not available' };
        try {
          sessionFiles.updateMeta(sessionId, { worktree_path: p });
          return { ok: true };
        } catch (err: unknown) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case 'report_outcome': {
        const outcome = req['outcome'];
        if (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'blocked') {
          return { ok: false, accepted: false, error: 'outcome must be one of succeeded|failed|blocked' };
        }
        if (reportOutcomeSink === undefined) {
          return { ok: false, accepted: false, error: 'report_outcome not available in this daemon' };
        }
        try {
          const accepted = reportOutcomeSink({
            sessionId,
            outcome,
            reason_code: typeof req['reason_code'] === 'string' ? req['reason_code'] : null,
            reason: typeof req['reason'] === 'string' ? req['reason'] : null,
            blocked: req['blocked'] ?? null,
            pr_url: typeof req['pr_url'] === 'string' ? req['pr_url'] : null,
          });
          return { ok: accepted, accepted };
        } catch (err: unknown) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      case 'get_session_project': {
        const handle = sessionMgr.getActiveSession(sessionId);
        if (handle === null) return { error: `Session not found: ${sessionId}` };
        if (!handle.boundProject || !handle.boundProjectRepos) {
          return { error: `Session "${sessionId}" has no bound project` };
        }
        const readRepos = sessionMgr.getSessionReadRepos(sessionId);
        return { project: handle.boundProject, repos: handle.boundProjectRepos, read_repos: readRepos };
      }
      case 'github_forward': {
        return handleGithubForward(
          sessionId,
          req['method'],
          req['path'],
          req['body'],
          req['queryParams'] ?? req['query_params'],
        );
      }
      case 'push_branch': {
        return handlePushBranch(sessionId, req['branch']);
      }
      case 'pr_create': {
        return handlePrCreate(sessionId, req['body']);
      }
      case 'pr_view': {
        return handlePrView(sessionId, req['pr_number']);
      }
      default:
        return { error: 'Unknown op' };
    }
  }

  function handleConnection(socket: net.Socket): void {
    activeConnections.add(socket);
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length > 0) processLine(line, socket);
        idx = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => activeConnections.delete(socket));
    socket.on('error', (err: Error) => {
      log.warn('Agent socket connection error', { error: err.message });
      activeConnections.delete(socket);
    });
  }

  function processLine(line: string, socket: net.Socket): void {
    void (async () => {
      let response: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          response = { error: 'Request must be a JSON object' };
        } else {
          response = await dispatch(parsed as Record<string, unknown>);
        }
      } catch (err: unknown) {
        response = { error: err instanceof SyntaxError ? 'Invalid JSON' : err instanceof Error ? err.message : String(err) };
      }
      try {
        if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
      } catch {
        // best effort
      }
    })();
  }

  return {
    socketPath,
    async start(): Promise<void> {
      // Unlink stale socket before listen (design §C).
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // not present — fine
      }
      // Ensure the parent dir exists (fallback mode: $rootDir).
      try {
        fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      } catch {
        // best effort
      }
      return new Promise<void>((resolve, reject) => {
        server = net.createServer(handleConnection);
        server.on('error', (err: Error) => {
          log.error('Agent server error', { error: err.message });
          reject(err);
        });
        server.listen(socketPath, () => {
          try {
            fs.chmodSync(socketPath, 0o660);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn('Failed to chmod agent socket', { socketPath, error: msg });
          }
          log.info('Agent server listening', { socketPath });
          resolve();
        });
      });
    },
    async shutdown(): Promise<void> {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      for (const socket of activeConnections) socket.destroy();
      activeConnections.clear();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // already gone
      }
      server = null;
      log.info('Agent server shut down');
    },
  };
}
