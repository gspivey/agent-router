/**
 * SPA serving under `/app` (spa-overhaul Task 2 / ROADMAP 72).
 *
 * During the migration the Svelte 5 SPA built into `client/dist/` is mounted at
 * `/app` and `/app/*` while the legacy UI at `GET /` and `GET /ui` keeps serving
 * `renderWebUI` untouched. In production the daemon serves the compiled assets
 * with `serveStatic`; in development the Vite dev server owns `/app` (and proxies
 * the API back to the daemon), so this module is a no-op for `/app` in dev.
 *
 * The factory shape keeps the serving logic unit- and Playwright-testable and
 * keeps `createWebApp` readable. Auth is NOT applied here — the bearer-auth
 * middleware stays scoped to the API prefixes, so `/app/*` assets remain publicly
 * fetchable (the token lives inside the delivered HTML, not in the assets).
 */
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, Env, Hono } from 'hono';
import type { Logger } from './log.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The minimal slice of a Hono `Context` that the token-embed decision needs:
 * read access to request headers. Narrowing to this avoids coupling the
 * serving helpers to a specific Hono env type (Hono's `Context` is invariant
 * over its env, which otherwise forces awkward casts at the call site).
 */
export interface ProofContext {
  req: { header(name: string): string | undefined };
}

export interface SpaServingDeps {
  log: Logger;
  /** Repo-relative root of the built client. Default `./client/dist`. */
  clientDist?: string;
  /** Reads `process.env.NODE_ENV` by default; injectable for tests. */
  nodeEnv?: string;
  /** The daemon bearer token to embed into index.html, or null when none is minted. */
  token: string | null;
  /** True when the daemon is bound to a public interface (`config.bindPublic`). */
  bindPublic: boolean;
  /** True when the request carries trusted-proxy proof (e.g. cloudflared headers). */
  hasProxyProof(c: ProofContext): boolean;
}

const DEFAULT_CLIENT_DIST = './client/dist';
const SENTINEL = '<!--__DAEMON_TOKEN__-->';

/** True when the daemon is in development (SPA is served by Vite, not here). */
export function isDevMode(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development';
}

/**
 * The token to embed into the shell for this request, or null to embed nothing.
 *
 * Embed the token ONLY when the daemon is loopback-bound (`!bindPublic`) AND the
 * request carries NO trusted-proxy proof (`!hasProxyProof(c)`) — i.e. direct
 * loopback access by the operator on the same machine. In every other case
 * (public bind, or a proxied/tunnel request) embed null so the bearer secret is
 * never delivered to a remote user.
 */
export function embedTokenFor(c: ProofContext, deps: SpaServingDeps): string | null {
  return !deps.bindPublic && !deps.hasProxyProof(c) ? deps.token : null;
}

/**
 * Inject the token into (or strip the sentinel from) the SPA shell HTML.
 *
 * When `token` is a string, the sentinel is replaced with a script that assigns
 * `window.__DAEMON_TOKEN`; `JSON.stringify` escapes any special characters
 * (quotes, backslashes, `</script>`-style sequences) safely. When `token` is
 * null the sentinel is replaced with an empty string.
 */
export function injectToken(html: string, token: string | null): string {
  if (token === null) {
    return html.replace(SENTINEL, '');
  }
  return html.replace(SENTINEL, `<script>window.__DAEMON_TOKEN=${JSON.stringify(token)}</script>`);
}

/**
 * Register the SPA routes under `/app` onto the Hono app. MUST be called AFTER
 * all API routes so an API match always wins over the SPA catch-all.
 *
 * In development this is a no-op for `/app` (Vite owns it). In production it
 * registers the two bare-path shell routes (`/app`, `/app/`) BEFORE the `/app/*`
 * asset catch-all so the shell handler wins for those two paths.
 */
export function registerSpaRoutes<E extends Env>(app: Hono<E>, deps: SpaServingDeps): void {
  const nodeEnv = deps.nodeEnv ?? process.env.NODE_ENV;
  if (isDevMode(nodeEnv)) {
    // Vite owns /app in dev; the daemon only serves the API.
    return;
  }

  const clientDist = deps.clientDist ?? DEFAULT_CLIENT_DIST;
  const indexPath = path.join(clientDist, 'index.html');

  // Missing-build guard: warn but still register so the API and legacy UI keep
  // serving. The shell handler re-reads/caches lazily, so a build that lands
  // after startup is picked up on the next request.
  if (!fs.existsSync(indexPath)) {
    deps.log.warn('SPA build not found; /app shell will 404 until built', { path: indexPath });
  }

  let cachedShell: string | null = null;

  function readShell(): string | null {
    if (cachedShell !== null) return cachedShell;
    try {
      cachedShell = fs.readFileSync(indexPath, 'utf8');
      return cachedShell;
    } catch {
      return null;
    }
  }

  /** Serve client/dist/index.html with the per-request optional token embed. */
  function serveIndexWithOptionalToken(c: Context<E>): Response {
    const shell = readShell();
    if (shell === null) {
      return c.text('SPA build not found', 404);
    }
    const token = embedTokenFor(c, deps);
    const body = injectToken(shell, token);
    c.header('Content-Type', 'text/html; charset=utf-8');
    // A token-bearing shell must never be cached by the browser or an intermediary.
    if (token !== null) {
      c.header('Cache-Control', 'no-store');
    }
    return c.body(body);
  }

  // Bare-path shell routes FIRST so they win for /app and /app/.
  app.get('/app', serveIndexWithOptionalToken);
  app.get('/app/', serveIndexWithOptionalToken);

  // Asset catch-all: strip the /app prefix so assets referenced under /app/assets/*
  // (Vite base '/app/') resolve to client/dist/assets/* with the correct MIME.
  // index.html is NOT served through this catch-all.
  app.use(
    '/app/*',
    serveStatic({
      root: clientDist,
      rewriteRequestPath: (p) => p.replace(/^\/app/, ''),
    }),
  );
}
