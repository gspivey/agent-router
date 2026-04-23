/**
 * Tier 2 test: daemon refuses to start with invalid config.
 * Requirements: 15.6, 24.6
 *
 * Spawns the daemon process with various invalid config files and asserts
 * it exits with a non-zero exit code and logs a descriptive FatalError message.
 */
import { describe, it, expect } from 'vitest';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SRC_INDEX = path.resolve(PROJECT_ROOT, 'src/index.ts');

interface DaemonResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the daemon with a given config object written to config.json in a temp dir.
 * The cwd is the project root so tsx resolves from node_modules.
 * AGENT_ROUTER_HOME points to the temp dir containing the config.
 */
function spawnDaemonWithConfig(config: unknown): Promise<DaemonResult> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-router-cfgtest-'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));

  return spawnDaemon(rootDir);
}

/**
 * Spawn the daemon with a raw string written as config.json (for invalid JSON tests).
 */
function spawnDaemonWithRawConfig(rawContent: string): Promise<DaemonResult> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-router-cfgtest-'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, rawContent);

  return spawnDaemon(rootDir);
}

function spawnDaemon(rootDir: string): Promise<DaemonResult> {
  return new Promise<DaemonResult>((resolve) => {
    const proc = cp.spawn('node', ['--import', 'tsx/esm', SRC_INDEX], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env as Record<string, string>,
        AGENT_ROUTER_HOME: rootDir,
        LOG_LEVEL: 'debug',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
    }, 15_000);

    proc.once('exit', (code) => {
      clearTimeout(timeout);
      fs.rmSync(rootDir, { recursive: true, force: true });
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

describe('Tier 2: daemon refuses to start with invalid config', () => {
  it('exits non-zero when port is missing', async () => {
    const result = await spawnDaemonWithConfig({
      webhookSecret: 'test-secret',
      kiroPath: '/usr/bin/env',
      repos: [{ owner: 'o', name: 'r' }],
      cron: [],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('FatalError');
    expect(result.stderr).toContain('port');
  });

  it('exits non-zero when webhookSecret is empty', async () => {
    const result = await spawnDaemonWithConfig({
      port: 3000,
      webhookSecret: '',
      kiroPath: '/usr/bin/env',
      repos: [{ owner: 'o', name: 'r' }],
      cron: [],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('FatalError');
    expect(result.stderr).toContain('webhookSecret');
  });

  it('exits non-zero when kiroPath points to a non-existent file', async () => {
    const result = await spawnDaemonWithConfig({
      port: 3000,
      webhookSecret: 'test-secret',
      kiroPath: '/nonexistent/path/to/kiro',
      repos: [{ owner: 'o', name: 'r' }],
      cron: [],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('FatalError');
    expect(result.stderr).toContain('kiroPath');
  });

  it('exits non-zero when config.json contains invalid JSON', async () => {
    const result = await spawnDaemonWithRawConfig('{ not valid json !!!');

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('FatalError');
  });

  it('exits non-zero when repos is not an array', async () => {
    const result = await spawnDaemonWithConfig({
      port: 3000,
      webhookSecret: 'test-secret',
      kiroPath: '/usr/bin/env',
      repos: 'not-an-array',
      cron: [],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('FatalError');
    expect(result.stderr).toContain('repos');
  });
});
