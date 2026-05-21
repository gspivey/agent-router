/**
 * Tier 1 tests: Daemon hook token store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDaemonTokenStore } from '../../src/daemon-token.js';
import { createLogger } from '../../src/log.js';

let rootDir: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-token-test-'));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('createDaemonTokenStore', () => {
  it('generates a 64-hex-char token on construction', () => {
    const store = createDaemonTokenStore({ rootDir, log: createLogger({ level: 'error', output: () => {} }) });
    expect(store.read()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the token to $rootDir/daemon-token with mode 0600', () => {
    const store = createDaemonTokenStore({ rootDir, log: createLogger({ level: 'error', output: () => {} }) });
    const filePath = path.join(rootDir, 'daemon-token');
    expect(fs.existsSync(filePath)).toBe(true);
    const stat = fs.statSync(filePath);
    // mode & 0o777 isolates the permission bits
    expect((stat.mode & 0o777).toString(8)).toBe('600');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(store.read());
  });

  it('returns the cached token on read() without re-reading the file', () => {
    const store = createDaemonTokenStore({ rootDir, log: createLogger({ level: 'error', output: () => {} }) });
    const initial = store.read();
    // Mutate the file underneath the store
    fs.writeFileSync(path.join(rootDir, 'daemon-token'), 'not-the-real-token', { mode: 0o600 });
    expect(store.read()).toBe(initial);
  });

  it('rotate() produces a different token and overwrites the file', () => {
    const store = createDaemonTokenStore({ rootDir, log: createLogger({ level: 'error', output: () => {} }) });
    const initial = store.read();
    const rotated = store.rotate();
    expect(rotated).not.toBe(initial);
    expect(store.read()).toBe(rotated);
    expect(fs.readFileSync(path.join(rootDir, 'daemon-token'), 'utf8')).toBe(rotated);
  });

  it('two separate stores in the same rootDir produce different tokens', () => {
    const log = createLogger({ level: 'error', output: () => {} });
    const a = createDaemonTokenStore({ rootDir, log });
    const tokenA = a.read();
    const b = createDaemonTokenStore({ rootDir, log });
    const tokenB = b.read();
    expect(tokenA).not.toBe(tokenB);
    // The most recently constructed store wins on disk
    expect(fs.readFileSync(path.join(rootDir, 'daemon-token'), 'utf8')).toBe(tokenB);
  });

  it('filePath() returns the absolute path to the token file', () => {
    const store = createDaemonTokenStore({ rootDir, log: createLogger({ level: 'error', output: () => {} }) });
    expect(store.filePath()).toBe(path.join(rootDir, 'daemon-token'));
  });
});
