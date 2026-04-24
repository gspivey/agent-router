/**
 * Tier 3 real e2e test: daemon receives a real GitHub webhook,
 * wakes real Kiro via ACP, and we verify the full loop.
 *
 * Flow:
 *   1. Start daemon as child process with real config
 *   2. Create a session via CLI IPC
 *   3. Register a PR for the session
 *   4. Post an `/agent` comment on the real PR via Octokit
 *      → GitHub sends webhook → tunnel → daemon
 *   5. Poll stream.log for prompt_injected + agent activity
 *
 * Requires env vars: GITHUB_TOKEN, GITHUB_TEST_REPO, GITHUB_WEBHOOK_SECRET,
 *                    WEBHOOK_URL, KIRO_PATH
 *
 * Skips gracefully if any are missing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { Octokit } from '@octokit/rest';

// ---------------------------------------------------------------------------
// Env check — skip entire suite if not configured
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env['GITHUB_TOKEN'] ?? '';
const GITHUB_TEST_REPO = process.env['GITHUB_TEST_REPO'] ?? '';
const GITHUB_WEBHOOK_SECRET = process.env['GITHUB_WEBHOOK_SECRET'] ?? '';
const WEBHOOK_URL = process.env['WEBHOOK_URL'] ?? '';
const KIRO_PATH = process.env['KIRO_PATH'] ?? '';

const hasAllEnv =
  !!GITHUB_TOKEN &&
  !!GITHUB_TEST_REPO &&
  !!GITHUB_WEBHOOK_SECRET &&
  !!WEBHOOK_URL &&
  !!KIRO_PATH;

const [owner, repo] = GITHUB_TEST_REPO.split('/');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Send a JSON request over the daemon's Unix socket and get the response. */
function ipcRequest(socketPath: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.on('connect', () => {
      sock.write(JSON.stringify(req) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        sock.destroy();
        resolve(JSON.parse(buf.slice(0, idx)) as Record<string, unknown>);
      }
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('IPC timeout')); }, 10_000);
  });
}

/** Wait for the daemon's Unix socket to become connectable. */
async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection(socketPath);
        sock.on('connect', () => { sock.destroy(); resolve(); });
        sock.on('error', reject);
      });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Daemon socket not ready after ${timeoutMs}ms`);
}

/** Poll a file for a line matching a predicate. */
async function pollStreamLog(
  streamPath: string,
  predicate: (entry: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(streamPath)) {
      const content = fs.readFileSync(streamPath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (predicate(entry)) return entry;
        } catch { /* skip malformed */ }
      }
    }
    await sleep(2_000);
  }
  // Dump what we have for debugging
  if (fs.existsSync(streamPath)) {
    const content = fs.readFileSync(streamPath, 'utf-8');
    console.error('stream.log contents at timeout:\n', content);
  }
  throw new Error(`stream.log predicate not matched within ${timeoutMs / 1000}s`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasAllEnv)('Tier 3 real e2e: webhook → daemon → Kiro', () => {
  let rootDir: string;
  let daemon: ChildProcess;
  let octokit: Octokit;
  let prNumber: number;
  let socketPath: string;
  let sessionId: string;
  let streamPath: string;
  const daemonPort = 3000;

  beforeAll(async () => {
    octokit = new Octokit({ auth: GITHUB_TOKEN });

    // Create a temp AGENT_ROUTER_HOME
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier3-e2e-'));
    socketPath = path.join(rootDir, 'sock');
    fs.mkdirSync(path.join(rootDir, 'sessions'), { recursive: true });

    // Write config.json
    const config = {
      port: daemonPort,
      webhookSecret: GITHUB_WEBHOOK_SECRET,
      kiroPath: KIRO_PATH,
      rateLimit: { perPRSeconds: 5 },
      repos: [{ owner: owner!, name: repo! }],
      cron: [],
    };
    fs.writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(config, null, 2));

    // Create a real PR on the test repo
    const branch = `test-e2e-${Date.now()}`;
    const { data: repoData } = await octokit.repos.get({ owner: owner!, repo: repo! });
    const defaultBranch = repoData.default_branch;
    const { data: refData } = await octokit.git.getRef({ owner: owner!, repo: repo!, ref: `heads/${defaultBranch}` });

    await octokit.git.createRef({
      owner: owner!, repo: repo!,
      ref: `refs/heads/${branch}`,
      sha: refData.object.sha,
    });

    await octokit.repos.createOrUpdateFileContents({
      owner: owner!, repo: repo!,
      path: `test-artifacts/${branch}.txt`,
      message: `test: e2e branch ${branch}`,
      content: Buffer.from(`e2e test ${new Date().toISOString()}\n`).toString('base64'),
      branch,
    });

    const { data: pr } = await octokit.pulls.create({
      owner: owner!, repo: repo!,
      title: `E2E Test PR — ${branch}`,
      body: 'Automated Tier 3 e2e test. Will be cleaned up.',
      head: branch,
      base: defaultBranch,
    });
    prNumber = pr.number;

    // Start the daemon
    daemon = spawn('node', ['--import', 'tsx/esm', 'src/index.ts'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        AGENT_ROUTER_HOME: rootDir,
        LOG_LEVEL: 'debug',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Log daemon output for debugging
    daemon.stdout?.on('data', (d: Buffer) => process.stderr.write(`[daemon stdout] ${d.toString()}`));
    daemon.stderr?.on('data', (d: Buffer) => process.stderr.write(`[daemon stderr] ${d.toString()}`));

    // Wait for daemon to be ready
    await waitForSocket(socketPath, 15_000);

    // Create a session via IPC
    const sessionRes = await ipcRequest(socketPath, { op: 'new_session', prompt: 'E2E test session — respond briefly to any prompt' });
    console.error('[e2e] new_session response:', JSON.stringify(sessionRes));
    if (sessionRes['error']) {
      throw new Error(`new_session failed: ${sessionRes['error']}`);
    }
    sessionId = sessionRes['session_id'] as string;
    streamPath = sessionRes['stream_path'] as string;
    expect(sessionId).toBeTruthy();

    // Register the PR
    const regRes = await ipcRequest(socketPath, {
      op: 'register_pr',
      session_id: sessionId,
      repo: `${owner}/${repo}`,
      pr_number: prNumber,
    });
    console.error('[e2e] register_pr response:', JSON.stringify(regRes));
    if (regRes['error']) {
      throw new Error(`register_pr failed: ${regRes['error']}`);
    }
    expect(regRes['ok']).toBe(true);

    // Give the session a moment to fully initialize
    await sleep(2_000);
  }, 120_000);

  afterAll(async () => {
    // Terminate daemon
    if (daemon && !daemon.killed) {
      daemon.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        daemon.on('exit', () => resolve());
        setTimeout(() => { daemon.kill('SIGKILL'); resolve(); }, 5_000);
      });
    }

    // Close the PR
    try {
      await octokit.pulls.update({ owner: owner!, repo: repo!, pull_number: prNumber, state: 'closed' });
    } catch { /* best effort */ }

    // Delete the test branch
    try {
      const { data: pr } = await octokit.pulls.get({ owner: owner!, repo: repo!, pull_number: prNumber });
      await octokit.git.deleteRef({ owner: owner!, repo: repo!, ref: `heads/${pr.head.ref}` });
    } catch { /* best effort */ }

    // Clean up temp dir
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }, 60_000);

  it('receives a real GitHub webhook and wakes Kiro', async () => {
    // Post an /agent comment on the PR — this triggers GitHub to send
    // an issue_comment webhook to our tunnel → daemon
    await octokit.issues.createComment({
      owner: owner!,
      repo: repo!,
      issue_number: prNumber,
      body: '/agent Say hello — this is an automated e2e test',
    });

    // Poll stream.log for the prompt_injected entry from the webhook
    const injected = await pollStreamLog(
      streamPath,
      (e) => e['type'] === 'prompt_injected' && e['prompt_source'] === 'webhook',
      90_000,
    );
    expect(injected).toBeDefined();
    expect(injected['source']).toBe('router');

    // Now look for any agent activity (message, tool_call, etc.)
    const agentActivity = await pollStreamLog(
      streamPath,
      (e) => e['source'] === 'agent',
      120_000,
    );
    expect(agentActivity).toBeDefined();
    expect(agentActivity['source']).toBe('agent');
  }, 300_000); // 5 minute timeout — real Kiro takes time
});
