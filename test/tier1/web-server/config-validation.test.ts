import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../../../src/config.js';
import { FatalError } from '../../../src/errors.js';

const tempDirs: string[] = [];

function createExecutable(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-val-'));
  const filePath = path.join(dir, 'fake-kiro');
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(filePath, 0o755);
  tempDirs.push(dir);
  return filePath;
}

function createSecretFile(mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-val-secret-'));
  const filePath = path.join(dir, 'proxy-secret');
  fs.writeFileSync(filePath, 'test-secret-value\n');
  fs.chmodSync(filePath, mode);
  tempDirs.push(dir);
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    port: 3000,
    webhookSecret: 'test-secret',
    kiroPath: createExecutable(),
    repos: [{ owner: 'myorg', name: 'myrepo' }],
    cron: [],
    ...overrides,
  };
}

describe('config validation: controlPort vs port conflict', () => {
  it('throws FatalError when controlPort === port', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65535 }),
        (port) => {
          const cfg = validConfig({ port, controlPort: port });
          expect(() => validateConfig(cfg)).toThrow(FatalError);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('accepts controlPort !== port', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65534 }),
        (port) => {
          const controlPort = port + 1;
          const cfg = validConfig({ port, controlPort });
          const result = validateConfig(cfg);
          expect(result.controlPort).toBe(controlPort);
          expect(result.port).toBe(port);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('defaults controlPort to 3100 when omitted', () => {
    const cfg = validConfig({ port: 4000 });
    const result = validateConfig(cfg);
    expect(result.controlPort).toBe(3100);
  });
});

describe('config validation: trustedProxy incomplete config', () => {
  it('throws FatalError when trustedProxy is missing any required field', () => {
    const fields = ['identityHeader', 'proofHeader', 'proofSecret'];
    fc.assert(
      fc.property(
        fc.subarray(fields, { minLength: 1, maxLength: 2 }),
        (presentFields) => {
          const proxyObj: Record<string, string> = {};
          for (const f of presentFields) {
            proxyObj[f] = f === 'proofSecret' ? createSecretFile() : `X-${f}`;
          }
          const cfg = validConfig({ trustedProxy: proxyObj });
          expect(() => validateConfig(cfg)).toThrow(FatalError);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('accepts trustedProxy with all three required fields', () => {
    const secretFile = createSecretFile();
    const cfg = validConfig({
      trustedProxy: {
        identityHeader: 'X-User-Email',
        proofHeader: 'X-Proof',
        proofSecret: secretFile,
      },
    });
    const result = validateConfig(cfg);
    expect(result.trustedProxy).toBeDefined();
    expect(result.trustedProxy!.identityHeader).toBe('X-User-Email');
    expect(result.trustedProxy!.proofHeader).toBe('X-Proof');
    expect(result.trustedProxy!.proofSecret).toBe(secretFile);
  });

  it('throws FatalError when proofSecret file does not exist', () => {
    const cfg = validConfig({
      trustedProxy: {
        identityHeader: 'X-User-Email',
        proofHeader: 'X-Proof',
        proofSecret: '/nonexistent/path/secret',
      },
    });
    expect(() => validateConfig(cfg)).toThrow(FatalError);
  });
});

describe('config validation: allowedEmails', () => {
  it('rejects entries that are empty strings', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constant(''), { minLength: 1, maxLength: 5 }),
        (emails) => {
          const cfg = validConfig({ allowedEmails: emails });
          expect(() => validateConfig(cfg)).toThrow(FatalError);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects entries longer than 254 characters', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 255, maxLength: 500 }),
        (longEmail) => {
          const cfg = validConfig({ allowedEmails: [longEmail] });
          expect(() => validateConfig(cfg)).toThrow(FatalError);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('accepts valid non-empty strings ≤254 chars', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 254 }), { minLength: 1, maxLength: 5 }),
        (emails) => {
          const cfg = validConfig({ allowedEmails: emails });
          const result = validateConfig(cfg);
          expect(result.allowedEmails).toEqual(emails);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('omitting allowedEmails leaves it undefined', () => {
    const cfg = validConfig();
    const result = validateConfig(cfg);
    expect(result.allowedEmails).toBeUndefined();
  });
});

describe('config validation: bindPublic and shutdownDrainSeconds', () => {
  it('defaults bindPublic to false', () => {
    const cfg = validConfig();
    const result = validateConfig(cfg);
    expect(result.bindPublic).toBe(false);
  });

  it('accepts bindPublic true/false', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        (val) => {
          const cfg = validConfig({ bindPublic: val });
          const result = validateConfig(cfg);
          expect(result.bindPublic).toBe(val);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('defaults shutdownDrainSeconds to 60', () => {
    const cfg = validConfig();
    const result = validateConfig(cfg);
    expect(result.shutdownDrainSeconds).toBe(60);
  });

  it('accepts positive integers for shutdownDrainSeconds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3600 }),
        (val) => {
          const cfg = validConfig({ shutdownDrainSeconds: val });
          const result = validateConfig(cfg);
          expect(result.shutdownDrainSeconds).toBe(val);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects non-positive shutdownDrainSeconds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100, max: 0 }),
        (val) => {
          const cfg = validConfig({ shutdownDrainSeconds: val });
          expect(() => validateConfig(cfg)).toThrow(FatalError);
        },
      ),
      { numRuns: 100 },
    );
  });
});
