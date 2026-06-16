import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { watchConfig } from '../../src/config-watch.js';
import type { AgentRouterConfig } from '../../src/config.js';

function writeValidConfig(configPath: string, overrides?: Record<string, unknown>): void {
  const cfg = {
    port: 3000,
    webhookSecret: 'test-secret',
    kiroPath: process.execPath, // Use node binary as a valid executable
    repos: [{ owner: 'org', name: 'repo' }],
    cron: [],
    controlPort: 3100,
    ...overrides,
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg));
}

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-watch-test-'));
  configPath = path.join(tmpDir, 'config.json');
  writeValidConfig(configPath);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('watchConfig', () => {
  it('calls onReload after debounce when config changes', async () => {
    let reloaded: AgentRouterConfig | null = null;
    const watcher = watchConfig(configPath, (next) => {
      reloaded = next;
    }, () => {}, { debounceMs: 50 });

    try {
      // Trigger a change
      writeValidConfig(configPath, { rateLimit: { perPRSeconds: 99 } });

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 150));
      expect(reloaded).not.toBeNull();
      expect(reloaded!.rateLimit.perPRSeconds).toBe(99);
    } finally {
      watcher.close();
    }
  });

  it('calls onError and retains previous on invalid config', async () => {
    let errorCalled: Error | null = null;
    let reloadCalled = false;
    const watcher = watchConfig(configPath, () => {
      reloadCalled = true;
    }, (err) => {
      errorCalled = err;
    }, { debounceMs: 50 });

    try {
      // Write invalid JSON
      fs.writeFileSync(configPath, 'not valid json!!!');

      await new Promise((r) => setTimeout(r, 150));
      expect(errorCalled).not.toBeNull();
      expect(reloadCalled).toBe(false);
    } finally {
      watcher.close();
    }
  });

  it('debounces rapid writes into a single reload', async () => {
    let reloadCount = 0;
    const watcher = watchConfig(configPath, () => {
      reloadCount++;
    }, () => {}, { debounceMs: 100 });

    try {
      // Rapid writes
      for (let i = 0; i < 5; i++) {
        writeValidConfig(configPath, { rateLimit: { perPRSeconds: i + 1 } });
        await new Promise((r) => setTimeout(r, 20));
      }

      // Wait for debounce to settle
      await new Promise((r) => setTimeout(r, 200));
      expect(reloadCount).toBe(1);
    } finally {
      watcher.close();
    }
  });

  it('close() stops watching', async () => {
    let reloadCount = 0;
    const watcher = watchConfig(configPath, () => {
      reloadCount++;
    }, () => {}, { debounceMs: 50 });

    watcher.close();

    writeValidConfig(configPath, { rateLimit: { perPRSeconds: 200 } });
    await new Promise((r) => setTimeout(r, 150));
    expect(reloadCount).toBe(0);
  });
});
