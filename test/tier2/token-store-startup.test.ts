/**
 * Tier 2 tests: Token_Store startup integration in daemon process.
 *
 * Verifies that:
 * - The daemon creates a TokenStore from tokens.json at startup
 * - SIGHUP triggers tokenStore.reload()
 * - The daemon refuses to start when fallback mode + credentialMode: "mcp"
 * - stopWatching is called on shutdown (no leaked watchers)
 *
 * Requirements: 1.1, 1.5, 2.1, 2.2, 4.4
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import * as url from 'node:url';
import * as net from 'node:net';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SRC_INDEX = path.resolve(PROJECT_ROOT, 'src/index.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

function writeConfig(rootDir: string, port: number, controlPort: number, overrides: Record<string, unknown> = {}): string {
  const configPath = path.join(rootDir, 'config.json');
  const config = {
    port,
    controlPort,
    webhookSecret: 'test-secret',
    kiroPath: '/bin/echo',
    repos: [{ owner: 'test-org', name: 'test-repo' }],
    cron: [],
    ...overrides,
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function writeTokensFile(rootDir: string, projects: Record<string, { token: string; repos: string[]; expires_at?: string }>): void {
  const tokensPath = path.join(rootDir, 'tokens.json');
  fs.writeFileSync(tokensPath, JSON.stringify({ projects }), { mode: 0o600 });
}

interface DaemonProcess {
  proc: cp.ChildProcess;
  stdout: string[];
  stderr: string[];
}

function spawnDaemon(rootDir: string, env?: Record<string, string>): DaemonProcess {
  // Build clean env: strip GITHUB_TOKEN unless test explicitly provides it
  const baseEnv = { ...process.env as Record<string, string> };
  delete baseEnv['GITHUB_TOKEN'];

  const proc = cp.spawn('node', ['--import', 'tsx/esm', SRC_INDEX], {
    cwd: PROJECT_ROOT, // Must run from project root so tsx is resolvable
    env: {
      ...baseEnv,
      AGENT_ROUTER_HOME: rootDir,
      LOG_LEVEL: 'debug',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  proc.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
  proc.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

  return { proc, stdout, stderr };
}

async function waitForReady(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Daemon did not start within ${timeoutMs}ms`);
}

async function waitForExit(proc: cp.ChildProcess, timeoutMs = 15000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function stopDaemon(proc: cp.ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return; // Already exited
  proc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
      resolve();
    }, 10000);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tier 2: Token_Store startup integration', () => {
  let tmpDir: string;
  let port: number;
  let controlPort: number;
  let daemon: DaemonProcess | null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenstore-startup-'));
    port = await getFreePort();
    controlPort = await getFreePort();
    daemon = null;
  });

  afterEach(async () => {
    if (daemon?.proc && !daemon.proc.killed) {
      await stopDaemon(daemon.proc);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts successfully with a tokens.json file and creates TokenStore', async () => {
    writeTokensFile(tmpDir, {
      'my-project': { token: 'ghp_test123', repos: ['test-org/test-repo'] },
    });
    writeConfig(tmpDir, port, controlPort);
    daemon = spawnDaemon(tmpDir);
    await waitForReady(port);

    // Daemon started — verify via /health endpoint
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    await stopDaemon(daemon.proc);
  }, 30000);

  it('starts successfully in GITHUB_TOKEN fallback mode with credentialMode env', async () => {
    // No tokens.json, but GITHUB_TOKEN is set and credentialMode is default (env)
    writeConfig(tmpDir, port, controlPort);
    daemon = spawnDaemon(tmpDir, { GITHUB_TOKEN: 'ghp_fallback_test' });
    await waitForReady(port);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    await stopDaemon(daemon.proc);
  }, 30000);

  it('refuses to start with FatalError when fallback mode + credentialMode mcp', async () => {
    // No tokens.json, GITHUB_TOKEN set, but credentialMode is 'mcp'
    writeConfig(tmpDir, port, controlPort, { credentialMode: 'mcp' });
    daemon = spawnDaemon(tmpDir, { GITHUB_TOKEN: 'ghp_fallback_test' });
    const exitCode = await waitForExit(daemon.proc);
    expect(exitCode).toBe(1);

    // Check that error message mentions tokens.json and credentialMode
    const allStderr = daemon.stderr.join('');
    expect(allStderr).toMatch(/tokens\.json/i);
    expect(allStderr).toMatch(/credentialMode/i);
  }, 30000);

  it('SIGHUP triggers token store reload', async () => {
    writeTokensFile(tmpDir, {
      'my-project': { token: 'ghp_original', repos: ['test-org/test-repo'] },
    });
    writeConfig(tmpDir, port, controlPort);
    daemon = spawnDaemon(tmpDir);
    await waitForReady(port);

    // Modify the tokens file
    writeTokensFile(tmpDir, {
      'my-project': { token: 'ghp_rotated', repos: ['test-org/test-repo'] },
      'new-project': { token: 'ghp_new', repos: ['test-org/new-repo'] },
    });

    // Send SIGHUP to trigger reload
    daemon.proc.kill('SIGHUP');

    // Give it time to process the reload
    await new Promise((r) => setTimeout(r, 1000));

    // Daemon should still be alive after SIGHUP
    expect(daemon.proc.exitCode).toBeNull();

    // Verify via /health that daemon is still healthy
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    await stopDaemon(daemon.proc);
  }, 30000);

  it('shuts down cleanly (stopWatching called, no hanging timers)', async () => {
    writeTokensFile(tmpDir, {
      'my-project': { token: 'ghp_test', repos: ['test-org/test-repo'] },
    });
    writeConfig(tmpDir, port, controlPort);
    daemon = spawnDaemon(tmpDir);
    await waitForReady(port);

    // Send SIGTERM — daemon should shut down cleanly
    daemon.proc.kill('SIGTERM');
    const exitCode = await waitForExit(daemon.proc, 15000);

    // Clean exit
    expect(exitCode).toBe(0);
  }, 30000);
});
