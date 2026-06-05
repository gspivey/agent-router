import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { SessionManager } from './session-mgr.js';
import type { SessionFiles } from './session-files.js';
import type { SSEBroker } from './sse-broker.js';
import type { DaemonTokenStore } from './daemon-token.js';
import type { Logger } from './log.js';
import type { AgentRouterConfig } from './config.js';
import { createAuthMiddleware, createWriteGuard } from './web-auth.js';
import type { AuthConfig, AuthResult } from './web-auth.js';
import { createWebRoutes } from './web-routes.js';
import { FatalError } from './errors.js';
import * as fs from 'node:fs';

type WebEnv = { Variables: { auth: AuthResult } };

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export { UUID_V4_RE };

function errorEnvelope(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export interface WebAppDeps {
  sessionMgr: SessionManager;
  sessionFiles: SessionFiles;
  sseBroker: SSEBroker;
  tokenStore: DaemonTokenStore;
  log: Logger;
  rootDir: string;
  config: AgentRouterConfig;
  shuttingDown: () => boolean;
}

export function createWebApp(deps: WebAppDeps): Hono<WebEnv> {
  const { tokenStore, config, sessionMgr, sessionFiles, sseBroker, rootDir, log, shuttingDown } = deps;

  const app = new Hono<WebEnv>();

  // --- Build auth config ---
  const authConfig: AuthConfig = { tokenStore };
  if (config.trustedProxy) {
    const secret = fs.readFileSync(config.trustedProxy.proofSecret);
    authConfig.trustedProxy = {
      identityHeader: config.trustedProxy.identityHeader,
      proofHeader: config.trustedProxy.proofHeader,
      secret,
    };
  }

  // --- Unauthenticated routes (UI) ---
  app.get('/', (c) => c.text('agent-router control plane'));
  app.get('/ui', (c) => c.text('agent-router control plane'));

  // --- Body limit for POST (applied before other middleware) ---
  app.post(
    '*',
    bodyLimit({
      maxSize: 65536,
      onError: (c) => c.json(errorEnvelope('payload_too_large', 'Request body exceeds 64KB limit'), 413),
    }),
  );

  // --- Content-Type validation for POST ---
  app.post('*', async (c, next) => {
    const ct = c.req.header('content-type');
    if (!ct || !ct.startsWith('application/json')) {
      return c.json(errorEnvelope('unsupported_media_type', 'Content-Type must be application/json'), 415);
    }
    await next();
  });

  // --- UUID :id validation middleware for /sessions/:id paths ---
  app.use('/sessions/:id', async (c, next) => {
    const id = c.req.param('id');
    if (!UUID_V4_RE.test(id)) {
      return c.json(errorEnvelope('invalid_session_id', 'Session ID must be a valid UUID v4'), 400);
    }
    await next();
  });
  app.use('/sessions/:id/*', async (c, next) => {
    const id = c.req.param('id');
    if (!UUID_V4_RE.test(id)) {
      return c.json(errorEnvelope('invalid_session_id', 'Session ID must be a valid UUID v4'), 400);
    }
    await next();
  });

  // --- Auth middleware (all authenticated routes) ---
  const authMiddleware = createAuthMiddleware(authConfig);
  app.use('/sessions', authMiddleware);
  app.use('/sessions/*', authMiddleware);

  // --- Write guard for POST endpoints ---
  const writeGuard = createWriteGuard(config.allowedEmails);
  app.post('/sessions/*', writeGuard);

  // --- Mount route handlers ---
  const routes = createWebRoutes({ sessionMgr, sessionFiles, sseBroker, rootDir, log, shuttingDown });
  app.route('/', routes);

  return app;
}

export function startWebServer(
  app: Hono<WebEnv>,
  config: Pick<AgentRouterConfig, 'controlPort' | 'port' | 'bindPublic'>,
  log: Logger,
): ServerType {
  const hostname = config.bindPublic ? '0.0.0.0' : '127.0.0.1';

  if (config.controlPort === config.port) {
    throw new FatalError(
      `Web server controlPort (${config.controlPort}) conflicts with webhook server port (${config.port})`,
    );
  }

  try {
    const server = serve({
      fetch: app.fetch,
      port: config.controlPort,
      hostname,
    });

    log.info('Web control plane listening', { address: hostname, port: config.controlPort });
    return server;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FatalError(`Failed to bind web server to ${hostname}:${config.controlPort}: ${msg}`);
  }
}
