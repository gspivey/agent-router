/**
 * Tier 2 test: Restart-required surfacing.
 * Requirement 2.1–2.4 from operator-controls spec task 6.1.
 *
 * Verifies that changing a restart-required field via config reload
 * sets a restart_required condition observable on GET /health, and
 * that reverting clears it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../../src/config.js';
import type { AgentRouterConfig } from '../../src/config.js';
import { watchConfig } from '../../src/config-watch.js';
import type { ConfigWatcher } from '../../src/config-watch.js';
import { createRestartRequiredState } from '../../src/restart-required.js';
import { createApp } from '../../src/server.js';
import type { Database, NewEvent } from '../../src/db.js';
import type { QueuedEvent } from '../../src/queue.js';
import type { Logger } from '../../src/log.js';

let tmpDir: string;
let configPath: string;

function writeConfig(overrides?: Partial<AgentRouterConfig>): void {
  const cfg = {
    port: 3000,
    webhookSecret: 'test-secret',
    kiroPath: process.execPath,
    repos: [{ owner: 'org', name: 'repo' }],
    cron: [],
    controlPort: 3100,
    ...overrides,
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg));
}

function makeLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => makeLogger() };
}

function makeDb(): Database {
  let nextId = 1;
  return {
    insertEvent: (_event: NewEvent) => nextId++,
    updateEventProcessed: () => {},
    markStaleEvents: () => {},
    findSession: () => null,
    tryAcquireWakeSlot: () => false,
    getLastWakedAt: () => null,
    insertSession: () => {},
    insertOutboundComment: () => {},
    isOutboundComment: () => false,
    pruneOutboundComments: () => {},
    upsertPendingWake: () => {},
    getDuePendingWakes: () => [],
    clearPendingWake: () => {},
    getEventById: () => undefined,
    getCronState: () => null,
    setCronPaused: () => {},
    getAllCronStates: () => [],
    walCheckpoint: () => {},
    shutdown: () => Promise.resolve(),
  } as unknown as Database;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-required-tier2-'));
  configPath = path.join(tmpDir, 'config.json');
  writeConfig();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Tier 2: restart-required surfacing via /health', () => {
  it('GET /health shows restart_required after reload changes a restart-required field', async () => {
    const startupConfig = loadConfig(configPath);
    const restartState = createRestartRequiredState();

    const app = createApp({
      webhookSecret: 'test-secret',
      repos: [],
      db: makeDb(),
      enqueue: (_event: QueuedEvent) => {},
      log: makeLogger(),
      health: {
        startedAtMs: Date.now(),
        activeSessionCount: () => 0,
        checkDb: () => true,
        restartRequired: () => restartState.get(),
      },
    });

    // Initially no restart_required
    let res = await app.request('/health', { method: 'GET' });
    expect(res.status).toBe(200);
    let body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('restart_required');

    // Simulate a config reload with changed port
    writeConfig({ port: 4000 });
    const reloadedConfig = loadConfig(configPath);
    restartState.update(startupConfig, reloadedConfig);

    // Now /health should expose restart_required
    res = await app.request('/health', { method: 'GET' });
    expect(res.status).toBe(200);
    body = (await res.json()) as Record<string, unknown>;
    expect(body.restart_required).toBeDefined();
    const rr = body.restart_required as { fields: string[]; since: string };
    expect(rr.fields).toContain('port');
    expect(rr.since).toBeTruthy();
  });

  it('restart_required clears when config reverts to startup values', async () => {
    const startupConfig = loadConfig(configPath);
    const restartState = createRestartRequiredState();

    const app = createApp({
      webhookSecret: 'test-secret',
      repos: [],
      db: makeDb(),
      enqueue: (_event: QueuedEvent) => {},
      log: makeLogger(),
      health: {
        startedAtMs: Date.now(),
        activeSessionCount: () => 0,
        checkDb: () => true,
        restartRequired: () => restartState.get(),
      },
    });

    // Trigger restart_required
    writeConfig({ port: 4000 });
    restartState.update(startupConfig, loadConfig(configPath));
    let res = await app.request('/health', { method: 'GET' });
    let body = (await res.json()) as Record<string, unknown>;
    expect(body.restart_required).toBeDefined();

    // Revert config
    writeConfig();
    restartState.update(startupConfig, loadConfig(configPath));
    res = await app.request('/health', { method: 'GET' });
    body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('restart_required');
  });

  it('watchConfig triggers restart_required update observable on /health', async () => {
    const startupConfig = loadConfig(configPath);
    const restartState = createRestartRequiredState();

    const app = createApp({
      webhookSecret: 'test-secret',
      repos: [],
      db: makeDb(),
      enqueue: (_event: QueuedEvent) => {},
      log: makeLogger(),
      health: {
        startedAtMs: Date.now(),
        activeSessionCount: () => 0,
        checkDb: () => true,
        restartRequired: () => restartState.get(),
      },
    });

    let watcher: ConfigWatcher | null = null;
    try {
      watcher = watchConfig(configPath, (next) => {
        restartState.update(startupConfig, next);
      }, () => {}, { debounceMs: 50 });

      // Change a restart-required field via file write
      writeConfig({ port: 5000 });
      await new Promise((r) => setTimeout(r, 150));

      const res = await app.request('/health', { method: 'GET' });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.restart_required).toBeDefined();
      const rr = body.restart_required as { fields: string[]; since: string };
      expect(rr.fields).toContain('port');
    } finally {
      watcher?.close();
    }
  });
});
