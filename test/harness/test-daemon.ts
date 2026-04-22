import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as cp from 'node:child_process';
import * as url from 'node:url';
import DatabaseConstructor from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { TestDaemon, TestDaemonOptions, GitHubBackend } from './interfaces.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SRC_INDEX = path.resolve(__dirname, '../../src/index.ts');

export class TestDaemonImpl implements TestDaemon {
  private proc: cp.ChildProcess | null = null;
  private _rootDir: string = '';
  private _port = 0;
  private _socketPath: string = '';

  async start(options: TestDaemonOptions): Promise<void> {
    this._rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-router-test-'));
    const dbPath = path.join(this._rootDir, 'agent-router.db');
    this._socketPath = path.join(this._rootDir, 'sock');

    // Assign a free port
    this._port = await getFreePort();

    const spawnCfg = options.kiroBackend.spawnConfig();

    const config = {
      port: this._port,
      webhookSecret: options.webhookSecret,
      kiroPath: spawnCfg.command,
      kiroArgs: spawnCfg.args,
      kiroEnv: spawnCfg.env,
      rateLimit: { perPRSeconds: 1 },
      repos: [{ owner: options.owner, name: options.repo }],
      cron: [],
    };

    const configPath = path.join(this._rootDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config));

    // Set the webhook target on the github backend
    if ('setDaemonWebhookUrl' in options.githubBackend) {
      (options.githubBackend as GitHubBackend & { setDaemonWebhookUrl(u: string): void })
        .setDaemonWebhookUrl(`http://127.0.0.1:${this._port}/webhook`);
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...spawnCfg.env,
      AGENT_ROUTER_HOME: this._rootDir,
      LOG_LEVEL: 'debug',
    };

    this.proc = cp.spawn('node', ['--import', 'tsx/esm', SRC_INDEX], {
      cwd: this._rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for the daemon to be ready (port listening)
    await this.waitForReady();
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      this.proc!.once('exit', () => resolve());
      setTimeout(() => {
        this.proc?.kill('SIGKILL');
        resolve();
      }, 5000);
    });
    this.proc = null;
    // Clean up temp dir
    if (this._rootDir) {
      fs.rmSync(this._rootDir, { recursive: true, force: true });
    }
  }

  socketPath(): string {
    return this._socketPath;
  }

  webhookUrl(): string {
    return `http://127.0.0.1:${this._port}/webhook`;
  }

  rootDir(): string {
    return this._rootDir;
  }

  getDb(): BetterSqlite3Database {
    const dbPath = path.join(this._rootDir, 'agent-router.db');
    return new DatabaseConstructor(dbPath, { readonly: true });
  }

  private async waitForReady(timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this._port}/health`);
        // Any response (even 404) means the server is up
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error(`Daemon did not start within ${timeoutMs}ms`);
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
