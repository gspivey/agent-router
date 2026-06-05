import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Hono } from 'hono';
import { createAuthMiddleware, createWriteGuard, isValidEmail } from '../../../src/web-auth.js';
import type { AuthConfig, AuthResult } from '../../../src/web-auth.js';
import type { DaemonTokenStore } from '../../../src/daemon-token.js';

function makeFakeTokenStore(token: string): DaemonTokenStore {
  return {
    read() { return token; },
    rotate() { return token; },
    filePath() { return '/fake/path'; },
  };
}

interface JsonBody {
  authenticated?: boolean;
  actor?: string;
  method?: string;
  error?: { code?: string; message?: string };
}

function makeApp(config: AuthConfig, writeGuardEmails?: readonly string[]) {
  const app = new Hono<{ Variables: { auth: AuthResult } }>();
  app.use('/*', createAuthMiddleware(config));
  app.get('/read', (c) => c.json(c.get('auth')));
  app.post('/write', createWriteGuard(writeGuardEmails), (c) => c.json(c.get('auth')));
  return app;
}

async function jsonBody(res: Response): Promise<JsonBody> {
  return (await res.json()) as JsonBody;
}

// Arbitrary: 64-char hex string (matching daemon token format)
const hexToken = fc.hexaString({ minLength: 64, maxLength: 64 });

// Arbitrary: valid email
const validEmail = fc.tuple(
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 50 }),
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.'.split('')), { minLength: 1, maxLength: 50 }),
).map(([local, domain]) => `${local}@${domain}`);

// Arbitrary: invalid email (no @, empty, or >254 chars)
const invalidEmail = fc.oneof(
  fc.constant(''),
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 50 }),
  fc.constant('@domain.com'),
  fc.constant('user@'),
  fc.stringOf(fc.char(), { minLength: 255, maxLength: 300 }),
);

describe('Property 1: Bearer Authentication Correctness', () => {
  it('authenticates with correct bearer token, actor "local", method "bearer"', async () => {
    await fc.assert(
      fc.asyncProperty(hexToken, async (token) => {
        const config: AuthConfig = { tokenStore: makeFakeTokenStore(token) };
        const app = makeApp(config);
        const res = await app.request('/read', {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        const body = await jsonBody(res);
        expect(body).toEqual({ authenticated: true, actor: 'local', method: 'bearer' });
      }),
      { numRuns: 100 },
    );
  });
});

describe('Property 2: Authentication Rejection', () => {
  it('rejects requests with wrong bearer token (401)', async () => {
    await fc.assert(
      fc.asyncProperty(
        hexToken,
        hexToken,
        async (realToken, wrongToken) => {
          if (wrongToken === realToken) return;
          const config: AuthConfig = { tokenStore: makeFakeTokenStore(realToken) };
          const app = makeApp(config);
          const res = await app.request('/read', {
            headers: { Authorization: `Bearer ${wrongToken}` },
          });
          expect(res.status).toBe(401);
          const body = await jsonBody(res);
          expect(body.error?.code).toBe('unauthorized');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects requests with no Authorization header', async () => {
    await fc.assert(
      fc.asyncProperty(hexToken, async (token) => {
        const config: AuthConfig = { tokenStore: makeFakeTokenStore(token) };
        const app = makeApp(config);
        const res = await app.request('/read');
        expect(res.status).toBe(401);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects requests with malformed Authorization header', async () => {
    await fc.assert(
      fc.asyncProperty(
        hexToken,
        fc.oneof(
          fc.constant('Basic dXNlcjpwYXNz'),
          fc.constant('Bearer '),
          fc.constant('Token abc123'),
          fc.constant(''),
        ),
        async (token, authHeader) => {
          const config: AuthConfig = { tokenStore: makeFakeTokenStore(token) };
          const app = makeApp(config);
          const res = await app.request('/read', {
            headers: { Authorization: authHeader },
          });
          expect(res.status).toBe(401);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 3: Proof-Before-Trust (Proxy Auth)', () => {
  it('does not trust identity header without valid proof', async () => {
    await fc.assert(
      fc.asyncProperty(
        hexToken,
        validEmail,
        fc.string({ minLength: 1, maxLength: 32 }).filter(s => s !== 'correct-secret-value'),
        async (token, email, wrongProof) => {
          const secret = Buffer.from('correct-secret-value');
          const config: AuthConfig = {
            tokenStore: makeFakeTokenStore(token),
            trustedProxy: {
              identityHeader: 'x-user-email',
              proofHeader: 'x-proxy-proof',
              secret,
            },
          };
          const app = makeApp(config);
          const res = await app.request('/read', {
            headers: {
              'x-user-email': email,
              'x-proxy-proof': wrongProof,
            },
          });
          expect(res.status).toBe(401);
          const body = await jsonBody(res);
          expect(body.error?.code).toBe('unauthorized');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('falls through to bearer when proof is invalid', async () => {
    await fc.assert(
      fc.asyncProperty(
        hexToken,
        validEmail,
        async (token, email) => {
          const secret = Buffer.from('the-real-secret');
          const config: AuthConfig = {
            tokenStore: makeFakeTokenStore(token),
            trustedProxy: {
              identityHeader: 'x-user-email',
              proofHeader: 'x-proxy-proof',
              secret,
            },
          };
          const app = makeApp(config);
          const res = await app.request('/read', {
            headers: {
              'x-user-email': email,
              'x-proxy-proof': 'wrong-secret',
              Authorization: `Bearer ${token}`,
            },
          });
          expect(res.status).toBe(200);
          const body = await jsonBody(res);
          expect(body.actor).toBe('local');
          expect(body.method).toBe('bearer');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('authenticates via proxy when proof is valid and email is valid', async () => {
    await fc.assert(
      fc.asyncProperty(
        hexToken,
        validEmail,
        async (token, email) => {
          const secret = Buffer.from('correct-proxy-secret');
          const config: AuthConfig = {
            tokenStore: makeFakeTokenStore(token),
            trustedProxy: {
              identityHeader: 'x-user-email',
              proofHeader: 'x-proxy-proof',
              secret,
            },
          };
          const app = makeApp(config);
          const res = await app.request('/read', {
            headers: {
              'x-user-email': email,
              'x-proxy-proof': 'correct-proxy-secret',
            },
          });
          expect(res.status).toBe(200);
          const body = await jsonBody(res);
          expect(body.actor).toBe(email);
          expect(body.method).toBe('proxy');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects with invalid_identity when proof valid but email malformed', async () => {
    await fc.assert(
      fc.asyncProperty(
        hexToken,
        invalidEmail,
        async (token, badEmail) => {
          const secret = Buffer.from('correct-proxy-secret');
          const config: AuthConfig = {
            tokenStore: makeFakeTokenStore(token),
            trustedProxy: {
              identityHeader: 'x-user-email',
              proofHeader: 'x-proxy-proof',
              secret,
            },
          };
          const app = makeApp(config);
          const res = await app.request('/read', {
            headers: {
              'x-user-email': badEmail,
              'x-proxy-proof': 'correct-proxy-secret',
            },
          });
          expect(res.status).toBe(401);
          const body = await jsonBody(res);
          expect(body.error?.code).toBe('invalid_identity');
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 4: Write Allowlist Enforcement', () => {
  it('rejects proxy-auth user not in allowlist with 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        hexToken,
        validEmail,
        validEmail,
        async (token, allowedEmail, otherEmail) => {
          if (otherEmail.toLowerCase() === allowedEmail.toLowerCase()) return;
          const secret = Buffer.from('proxy-secret');
          const config: AuthConfig = {
            tokenStore: makeFakeTokenStore(token),
            trustedProxy: {
              identityHeader: 'x-user-email',
              proofHeader: 'x-proxy-proof',
              secret,
            },
          };
          const app = makeApp(config, [allowedEmail]);
          const res = await app.request('/write', {
            method: 'POST',
            headers: {
              'x-user-email': otherEmail,
              'x-proxy-proof': 'proxy-secret',
              'Content-Type': 'application/json',
            },
            body: '{}',
          });
          expect(res.status).toBe(403);
          const body = await jsonBody(res);
          expect(body.error?.code).toBe('forbidden');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('allows proxy-auth user in allowlist (case-insensitive)', async () => {
    await fc.assert(
      fc.asyncProperty(
        hexToken,
        validEmail,
        async (token, email) => {
          const secret = Buffer.from('proxy-secret');
          const config: AuthConfig = {
            tokenStore: makeFakeTokenStore(token),
            trustedProxy: {
              identityHeader: 'x-user-email',
              proofHeader: 'x-proxy-proof',
              secret,
            },
          };
          // Allowlist has uppercase version
          const app = makeApp(config, [email.toUpperCase()]);
          const res = await app.request('/write', {
            method: 'POST',
            headers: {
              'x-user-email': email,
              'x-proxy-proof': 'proxy-secret',
              'Content-Type': 'application/json',
            },
            body: '{}',
          });
          expect(res.status).toBe(200);
          const body = await jsonBody(res);
          expect(body.method).toBe('proxy');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('bearer auth always bypasses allowlist', async () => {
    await fc.assert(
      fc.asyncProperty(hexToken, async (token) => {
        const config: AuthConfig = { tokenStore: makeFakeTokenStore(token) };
        // Restrictive allowlist — would reject any proxy user
        const app = makeApp(config, ['nobody@example.com']);
        const res = await app.request('/write', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        expect(res.status).toBe(200);
        const body = await jsonBody(res);
        expect(body.method).toBe('bearer');
      }),
      { numRuns: 100 },
    );
  });

  it('allows all proxy-auth users when no allowlist is configured', async () => {
    await fc.assert(
      fc.asyncProperty(
        hexToken,
        validEmail,
        async (token, email) => {
          const secret = Buffer.from('proxy-secret');
          const config: AuthConfig = {
            tokenStore: makeFakeTokenStore(token),
            trustedProxy: {
              identityHeader: 'x-user-email',
              proofHeader: 'x-proxy-proof',
              secret,
            },
          };
          // No allowlist passed to writeGuard
          const app = makeApp(config);
          const res = await app.request('/write', {
            method: 'POST',
            headers: {
              'x-user-email': email,
              'x-proxy-proof': 'proxy-secret',
              'Content-Type': 'application/json',
            },
            body: '{}',
          });
          expect(res.status).toBe(200);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('isValidEmail', () => {
  it('accepts valid emails', () => {
    fc.assert(
      fc.property(validEmail, (email) => {
        expect(isValidEmail(email)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects invalid emails', () => {
    fc.assert(
      fc.property(invalidEmail, (email) => {
        expect(isValidEmail(email)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
