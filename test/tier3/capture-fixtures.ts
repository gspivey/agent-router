/**
 * Standalone capture script (NOT a vitest test).
 *
 * Spins up a local daemon with payload capture enabled, creates a real PR on
 * the configured GitHub test repo, fires the webhook-generating actions we
 * don't yet have real captures for (review_comment, check_run), waits for
 * GitHub to deliver, then tears everything down.
 *
 * Required env (same as test/tier3/e2e-real.test.ts plus capture dir):
 *   GITHUB_TOKEN, GITHUB_TEST_REPO, GITHUB_WEBHOOK_SECRET,
 *   WEBHOOK_URL, KIRO_PATH, AGENT_ROUTER_CAPTURE_PAYLOADS
 *
 * Run:
 *   AGENT_ROUTER_CAPTURE_PAYLOADS="$(pwd)/test/fixtures/webhooks/raw" \
 *     npx tsx test/tier3/capture-fixtures.ts
 *
 * On success, the named directory contains one .json per delivered webhook.
 * Promote interesting ones into test/fixtures/webhooks/ with sidecar
 * <name>.expect.json files; the routing-matrix test auto-loads them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { Octokit } from '@octokit/rest';

const REQUIRED_ENV = [
  'GITHUB_TOKEN',
  'GITHUB_TEST_REPO',
  'GITHUB_WEBHOOK_SECRET',
  'WEBHOOK_URL',
  'KIRO_PATH',
  'AGENT_ROUTER_CAPTURE_PAYLOADS',
] as const;

function requireEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const k of REQUIRED_ENV) {
    const v = process.env[k];
    if (!v) missing.push(k);
    else out[k] = v;
  }
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    console.error('See the file header for the full list and usage.');
    process.exit(1);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

function ipcRequest(socketPath: string, req: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.on('connect', () => { sock.write(JSON.stringify(req) + '\n'); });
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

function logStep(msg: string): void {
  console.error(`[capture] ${msg}`);
}

async function main(): Promise<void> {
  const env = requireEnv();
  const [owner, repo] = env['GITHUB_TEST_REPO']!.split('/');
  if (!owner || !repo) {
    console.error(`GITHUB_TEST_REPO must be "owner/name", got: ${env['GITHUB_TEST_REPO']}`);
    process.exit(1);
  }

  const captureDir = env['AGENT_ROUTER_CAPTURE_PAYLOADS']!;
  fs.mkdirSync(captureDir, { recursive: true });

  const octokit = new Octokit({ auth: env['GITHUB_TOKEN']! });
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-fixtures-'));
  const socketPath = path.join(rootDir, 'sock');
  fs.mkdirSync(path.join(rootDir, 'sessions'), { recursive: true });

  // Daemon config
  const config = {
    port: 3000,
    webhookSecret: env['GITHUB_WEBHOOK_SECRET']!,
    kiroPath: env['KIRO_PATH']!,
    rateLimit: { perPRSeconds: 5 },
    repos: [{ owner: owner!, name: repo! }],
    cron: [],
  };
  fs.writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(config, null, 2));

  let daemon: ChildProcess | null = null;
  let prNumber: number | null = null;
  let branch: string | null = null;
  let headSha: string | null = null;

  // Cleanup runs on any exit path
  const cleanup = async (): Promise<void> => {
    if (daemon && !daemon.killed) {
      logStep('Stopping daemon');
      daemon.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        daemon!.on('exit', () => resolve());
        setTimeout(() => { daemon!.kill('SIGKILL'); resolve(); }, 5_000);
      });
    }
    if (prNumber !== null) {
      logStep(`Closing PR #${prNumber}`);
      try { await octokit.pulls.update({ owner: owner!, repo: repo!, pull_number: prNumber, state: 'closed' }); } catch { /* best effort */ }
    }
    if (branch !== null) {
      logStep(`Deleting branch ${branch}`);
      try { await octokit.git.deleteRef({ owner: owner!, repo: repo!, ref: `heads/${branch}` }); } catch { /* best effort */ }
    }
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

  try {
    // Spawn daemon
    logStep(`Spawning daemon (rootDir=${rootDir})`);
    daemon = spawn('node', ['--import', 'tsx/esm', 'src/index.ts'], {
      cwd: path.resolve('.'),
      env: { ...process.env, AGENT_ROUTER_HOME: rootDir, LOG_LEVEL: 'debug' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.stdout?.on('data', (d: Buffer) => process.stderr.write(`[daemon] ${d.toString()}`));
    daemon.stderr?.on('data', (d: Buffer) => process.stderr.write(`[daemon-err] ${d.toString()}`));
    await waitForSocket(socketPath, 15_000);
    logStep('Daemon ready');

    // Create session via IPC so wake policy can find a session for the PR.
    // We don't care about the agent's output here — just need the session to exist.
    const sessionRes = await ipcRequest(socketPath, {
      op: 'new_session',
      prompt: 'Fixture capture run — no work needed, just sit here.',
    });
    if (sessionRes['error']) throw new Error(`new_session failed: ${sessionRes['error'] as string}`);
    const sessionId = sessionRes['session_id'] as string;
    logStep(`Session created: ${sessionId}`);

    // Create branch + file + PR
    branch = `capture-${Date.now()}`;
    const { data: repoData } = await octokit.repos.get({ owner: owner!, repo: repo! });
    const defaultBranch = repoData.default_branch;
    const { data: refData } = await octokit.git.getRef({
      owner: owner!, repo: repo!, ref: `heads/${defaultBranch}`,
    });
    await octokit.git.createRef({
      owner: owner!, repo: repo!,
      ref: `refs/heads/${branch}`, sha: refData.object.sha,
    });
    const filePath = `test-artifacts/${branch}.txt`;
    const { data: commit } = await octokit.repos.createOrUpdateFileContents({
      owner: owner!, repo: repo!, path: filePath,
      message: `capture: ${branch}`,
      content: Buffer.from(`capture run\nline 2\nline 3\n`).toString('base64'),
      branch,
    });
    headSha = commit.commit.sha!;
    const { data: pr } = await octokit.pulls.create({
      owner: owner!, repo: repo!,
      title: `Capture run — ${branch}`,
      body: 'Standalone fixture capture. Cleaned up automatically.',
      head: branch, base: defaultBranch,
    });
    prNumber = pr.number;
    logStep(`PR #${prNumber} created (head ${headSha.slice(0, 8)})`);

    // Register PR so wake policy will route webhooks to our session
    const regRes = await ipcRequest(socketPath, {
      op: 'register_pr',
      session_id: sessionId,
      repo: `${owner}/${repo}`,
      pr_number: prNumber,
    });
    if (regRes['error']) throw new Error(`register_pr failed: ${regRes['error'] as string}`);

    // Settle so PR-creation webhooks land before we start firing more
    await sleep(3_000);

    // Fire each event-generating action independently. One failure
    // (e.g. check_run requires checks:write which classic PATs lack)
    // must not skip the captures from the others.
    async function tryFire(label: string, fn: () => Promise<unknown>): Promise<void> {
      try {
        logStep(`Firing ${label}`);
        await fn();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logStep(`${label} FAILED (continuing): ${msg}`);
      }
    }

    await tryFire('issue_comment', () =>
      octokit.issues.createComment({
        owner: owner!, repo: repo!, issue_number: prNumber!,
        body: '/agent capture-fixtures: issue_comment trigger',
      }),
    );

    await tryFire('pull_request_review_comment', () =>
      octokit.pulls.createReviewComment({
        owner: owner!, repo: repo!, pull_number: prNumber!,
        body: '/agent capture-fixtures: review comment on line 1',
        commit_id: headSha!,
        path: filePath,
        line: 1,
        side: 'RIGHT',
      }),
    );

    // Note: octokit.checks.create requires checks:write which classic PATs
    // don't have — only GitHub Apps and fine-grained PATs configured for it.
    // If yours fails with 403, configure a workflow in the test repo and the
    // resulting check_run webhooks will fire on the next capture run.
    await tryFire('check_run', () =>
      octokit.checks.create({
        owner: owner!, repo: repo!,
        name: 'capture-fixtures',
        head_sha: headSha!,
        status: 'completed',
        conclusion: 'failure',
        output: { title: 'Capture run', summary: 'Synthetic failure for fixture capture.' },
      }),
    );

    // Wait for webhooks to arrive at the daemon (tunnel + GitHub delivery latency)
    logStep('Waiting 15s for webhook delivery');
    await sleep(15_000);

    // Report what was captured
    const captured = fs.readdirSync(captureDir).filter((f) => f.endsWith('.json'));
    logStep(`Captured ${captured.length} payload(s):`);
    for (const f of captured) console.error(`  - ${f}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[capture] ERROR: ${msg}`);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[capture] FATAL: ${msg}`);
  process.exit(1);
});
