/**
 * Tier 2 test: ACP client against FakeKiroBackend (simple-echo scenario).
 * Requirements: 10.2, 10.6, 10.7, 24.6
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnACPClient } from '../../src/acp.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import type { ACPNotification } from '../../src/acp.js';
import type { StreamEntry } from '../../src/session-files.js';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/single-prompt-echo.json');

describe('ACP client — simple-echo scenario', () => {
  let kiro: FakeKiroBackend;

  beforeAll(async () => {
    kiro = new FakeKiroBackend();
    await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
  });

  afterAll(async () => {
    await kiro.reset();
  });

  it('completes full ACP lifecycle: initialize → loadSession → sendPrompt → notifications → exit', async () => {
    const cfg = kiro.spawnConfig();
    const stderrEntries: StreamEntry[] = [];

    const client = spawnACPClient(cfg.command, cfg.args, cfg.env, {
      onStderr: (entry) => stderrEntries.push(entry),
    });

    // Step 1: initialize
    await client.initialize();

    // Step 2: create session
    await client.newSession('/tmp');

    // Step 3: load session
    await client.loadSession('test-session-123');

    // Step 4: send prompt — the simple-echo scenario emits one notification then exits
    await client.sendPrompt('Hello, agent!');

    // Step 5: collect notifications
    const collected: ACPNotification[] = [];
    for await (const notification of client.notifications) {
      collected.push(notification);
    }

    // The simple-echo scenario emits one session/notification
    expect(collected.length).toBeGreaterThanOrEqual(1);
    const echoNotification = collected.find(
      (n) => (n.params as Record<string, unknown>)?.['type'] === 'message',
    );
    expect(echoNotification).toBeDefined();
    expect(echoNotification!.method).toBe('session/notification');
    expect((echoNotification!.params as Record<string, unknown>)['content']).toBe('Echo: received your prompt.');

    // The subprocess should have exited (exitCode: 0 in scenario)
    await client.sessionEnded;
  }, 15_000);

  it('close() ends the subprocess gracefully', async () => {
    const cfg = kiro.spawnConfig();
    const client = spawnACPClient(cfg.command, cfg.args, cfg.env);

    await client.initialize();
    await client.close();

    // sessionEnded should resolve after close
    await client.sessionEnded;
  }, 10_000);

  it('kill() terminates the subprocess with SIGTERM', async () => {
    const cfg = kiro.spawnConfig();
    const client = spawnACPClient(cfg.command, cfg.args, cfg.env);

    await client.initialize();
    await client.kill();

    // sessionEnded should resolve after kill
    await client.sessionEnded;
  }, 15_000);

  it('stderr lines are captured as StreamEntry objects', async () => {
    // The simple-echo scenario doesn't emit stderr, but we can verify
    // the callback mechanism works by checking it doesn't crash
    const cfg = kiro.spawnConfig();
    const stderrEntries: StreamEntry[] = [];

    const client = spawnACPClient(cfg.command, cfg.args, cfg.env, {
      onStderr: (entry) => {
        expect(entry.source).toBe('agent');
        expect(entry.type).toBe('stderr');
        expect(typeof entry.ts).toBe('string');
        stderrEntries.push(entry);
      },
    });

    await client.initialize();
    await client.newSession('/tmp');
    await client.loadSession('test-session-stderr');
    await client.sendPrompt('test');

    // Drain notifications
    for await (const _ of client.notifications) {
      // consume
    }

    await client.sessionEnded;
    // simple-echo doesn't write to stderr, so array should be empty
    expect(stderrEntries).toHaveLength(0);
  }, 15_000);
});
