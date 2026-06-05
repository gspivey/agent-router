import crypto from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { DaemonTokenStore } from './daemon-token.js';

export interface AuthResult {
  authenticated: true;
  actor: string;
  method: 'bearer' | 'proxy';
}

export interface AuthConfig {
  tokenStore: DaemonTokenStore;
  trustedProxy?: {
    identityHeader: string;
    proofHeader: string;
    secret: Buffer;
  };
}

function errorEnvelope(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/**
 * Validate email format: 1–254 chars, exactly one `@` with non-empty local and domain parts.
 */
export function isValidEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  const atIndex = value.indexOf('@');
  if (atIndex < 1) return false;
  if (value.indexOf('@', atIndex + 1) !== -1) return false;
  const domain = value.slice(atIndex + 1);
  return domain.length > 0;
}

/**
 * Timing-safe string comparison. Returns false if lengths differ.
 */
function timingSafeCompare(a: string, b: Buffer): boolean {
  const aBuf = Buffer.from(a);
  if (aBuf.length !== b.length) return false;
  return crypto.timingSafeEqual(aBuf, b);
}

/**
 * Creates auth middleware that resolves authentication via:
 * 1. Trusted-proxy proof header → identity extraction → email validation
 * 2. Bearer token → timing-safe compare
 * 3. Reject 401
 */
export function createAuthMiddleware(config: AuthConfig): MiddlewareHandler {
  const { tokenStore, trustedProxy } = config;

  return async (c, next) => {
    // Path 1: Trusted proxy authentication
    if (trustedProxy) {
      const proofValue = c.req.header(trustedProxy.proofHeader);
      if (proofValue !== undefined) {
        const proofValid = timingSafeCompare(proofValue, trustedProxy.secret);
        if (proofValid) {
          const identity = c.req.header(trustedProxy.identityHeader);
          if (identity === undefined || !isValidEmail(identity)) {
            return c.json(errorEnvelope('invalid_identity', 'Proof valid but identity header is missing or malformed'), 401);
          }
          c.set('auth', { authenticated: true, actor: identity, method: 'proxy' } satisfies AuthResult);
          await next();
          return;
        }
        // Proof present but invalid → fall through to bearer
      }
    }

    // Path 2: Bearer token authentication
    const authHeader = c.req.header('authorization');
    if (authHeader !== undefined && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (token.length > 0) {
        const expected = Buffer.from(tokenStore.read());
        const valid = timingSafeCompare(token, expected);
        if (valid) {
          c.set('auth', { authenticated: true, actor: 'local', method: 'bearer' } satisfies AuthResult);
          await next();
          return;
        }
      }
    }

    // Path 3: Reject
    return c.json(errorEnvelope('unauthorized', 'No valid authentication credentials'), 401);
  };
}

/**
 * Creates write guard middleware that enforces the allowedEmails allowlist.
 * Bearer-token auth always bypasses the allowlist.
 * Case-insensitive email matching.
 */
export function createWriteGuard(allowedEmails?: readonly string[]): MiddlewareHandler {
  const normalizedAllowlist = allowedEmails?.map(e => e.toLowerCase());

  return async (c, next) => {
    const auth: AuthResult = c.get('auth');

    // Bearer auth bypasses allowlist
    if (auth.method === 'bearer') {
      await next();
      return;
    }

    // No allowlist configured → allow all authenticated users
    if (normalizedAllowlist === undefined) {
      await next();
      return;
    }

    // Check proxy-authenticated email against allowlist (case-insensitive)
    if (normalizedAllowlist.includes(auth.actor.toLowerCase())) {
      await next();
      return;
    }

    return c.json(errorEnvelope('forbidden', 'Email not in write allowlist'), 403);
  };
}
