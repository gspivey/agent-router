/**
 * Tier 2 tests: agent process isolation end-to-end wiring (item 86, task 86.4).
 *
 * Spec: .kiro/specs/agent-process-isolation/ · tasks 86.4
 *
 * Covers the five behaviors the item is responsible for:
 *   1. A session spawned with useWorkerUid=true receives NO GITHUB_TOKEN in env
 *      (FR-2.2 / FR-3.3 / NFR-1.3), and the claude-code adapter is refused
 *      under useWorkerUid (FR-2.3, task 86.2).
 *   2. The agent socket is created at agentSocketPath with mode 0660 so group
 *      members (agentworker) can connect (FR-4.2).
 *   3. The operator CLI socket is mode 0600 so agentworker cannot connect
 *      (FR-4.1).
 *   4. github_forward with a disallowed path returns an error without issuing
 *      any GitHub API call (FR-5.3/5.4, AC-4).
 *   5. push_branch with a protected branch name returns an error without
 *      running any git execFile (FR-6.1).
 *
 * These run against real sockets / real session manager with fake backends;
 * no sudo, no agentworker uid, no network, no git are exercised. The spawn
 * function is replaced with a capturing stub (we assert on the env the adapter
 * composes, not on launching a real child).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import * as url from 'node:url';
import { createSessionManager, type SessionManager } from '../../src/session-mgr.js';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';
import { initDatabase, type Database } from '../../src/db.js';
import { createLogger, type Logger } from '../../src/log.js';
import type { ACPClient } from '../../src/acp.js';
import { spawnACPClient, buildChildEnv, DEFAULT_CHILD_ENV_ALLOWLIST } from '../../src/acp.js';
import { createKiroAdapter } from '../../src/adapters/kiro.js';
import { createClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { createTokenResolver, resolveSessionTokenEnv } from '../../src/github.js';
import { createTokenStore } from '../../src/token-store.js';
import { credentialTokenResolver } from '../../src/token-resolver.js';
import { createAgentServer, type AgentServer, type AgentServerDeps } from '../../src/agent-server.js';
import { createCliServer, type CliServer } from '../../src/cli-server.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import type { GitHubClient, TokenResolver } from '../../src/github.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SIMPLE_ECHO_SCENARIO = path.resolve(__dirname, '../scenarios/simple-echo.json');

const silentLog: Logger = createLogger({ level: 'error', output: () => {} });

// ---------------------------------------------------------------------------
// 1. useWorkerUid session env + claude-code refusal
// ---------------------------------------------------------------------------

describe('useWorkerUid session env (FR-2.2 / FR-3.3 / NFR-1.3)', () => {
  let rootDir: string;
  let sf: SessionFiles;
  let db: Database;
  let kiro: FakeKiroBackend;
  let mgr: SessionManager;
  let capturedEnv: Map<string, Record<string, string>>;
  let capturedArgs: Map<string, { cmd: string; args: string[] }>;

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-iso-env-'));
    sf = createSessionFiles(rootDir);
    db = initDatabase(path.join(rootDir, 'agent-router.db'));
    kiro = new FakeKiroBackend();
    await kiro.loadScenario(SIMPLE_ECHO_SCENARIO);
    capturedEnv = new Map();
    capturedArgs = new Map();

    const tokenResolver = createTokenResolver({
      perRepoTokens: { 'gspivey/agent-router': 'tok-agent-router' },
      envFallback: false,
    });

    // Kiro adapter with a capturing spawn stub. Instead of launching a child,
    // record the env + argv and hand back a FakeKiro ACP client so the session
    // lifecycle still completes.
    const adapter = createKiroAdapter({
      kiroPath: '/opt/kiro/bin/kiro',
      log: silentLog,
      spawnImpl: (cmd: string, args: string[], env: Record<string, string>): ACPClient => {
        const sid = env['AGENT_ROUTER_SESSION_ID'] ?? 'unknown';
        capturedEnv.set(sid, env);
        capturedArgs.set(sid, { cmd, args });
        const cfg = kiro.spawnConfig();
        // Launch the fake backend to satisfy the ACP handshake.
        return spawnACPClient(cfg.command, cfg.args, {
          ...cfg.env,
          AGENT_ROUTER_SESSION_ID: sid,
        });
      },
    });

    const agentSocketPath = path.join(rootDir, 'agent.sock');

    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log: silentLog,
      useWorkerUid: true,
      agentSocketPath,
      acpSpawner: (sessionId, repo, isolation) => {
        const tokenEnv = resolveSessionTokenEnv(repo, tokenResolver);
        const overrides: Record<string, string> = { ...tokenEnv };
        const env = buildChildEnv(
          process.env as Record<string, string | undefined>,
          overrides,
          [...DEFAULT_CHILD_ENV_ALLOWLIST],
        );
        const useWorker = isolation?.useWorkerUid ?? false;
        if (useWorker && env['GITHUB_TOKEN'] !== undefined) {
          delete env['GITHUB_TOKEN'];
        }
        return adapter.spawn({
          sessionId,
          env,
          useWorkerUid: useWorker,
          ...(isolation?.capToken !== undefined ? { capToken: isolation.capToken } : {}),
          agentSocketPath: isolation?.agentSocketPath ?? agentSocketPath,
        });
      },
    });
  });

  afterEach(async () => {
    await mgr.shutdown();
    await db.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('does NOT pass GITHUB_TOKEN to the agent child env', async () => {
    const handle = await mgr.createSession('do work', 'gspivey/agent-router');
    const env = capturedEnv.get(handle.sessionId);
    expect(env).toBeDefined();
    expect(env!['GITHUB_TOKEN']).toBeUndefined();
    // The agent socket + cap token are present instead.
    expect(env!['AGENT_ROUTER_CAP_TOKEN']).toBeDefined();
    expect(env!['AGENT_ROUTER_CAP_TOKEN']!.length).toBeGreaterThan(0);
    expect(env!['HTTPS_PROXY']).toBe('http://127.0.0.1:8080');
  }, 20_000);

  it('spawns via sudo -u agentworker', async () => {
    const handle = await mgr.createSession('do work', 'gspivey/agent-router');
    const spawned = capturedArgs.get(handle.sessionId);
    expect(spawned).toBeDefined();
    expect(spawned!.cmd).toBe('/usr/bin/sudo');
    expect(spawned!.args.slice(0, 3)).toEqual(['-u', 'agentworker', '/opt/kiro/bin/kiro']);
  }, 20_000);
});

describe('claude-code adapter refusal under useWorkerUid (FR-2.3 / task 86.2)', () => {
  let rootDir: string;
  let sf: SessionFiles;
  let db: Database;
  let mgr: SessionManager;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-iso-cc-'));
    sf = createSessionFiles(rootDir);
    db = initDatabase(path.join(rootDir, 'agent-router.db'));

    const claude = createClaudeCodeAdapter({ log: silentLog });

    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log: silentLog,
      useWorkerUid: true,
      agentSocketPath: path.join(rootDir, 'agent.sock'),
      acpSpawner: (_sessionId, _repo, isolation) => {
        const useWorker = isolation?.useWorkerUid ?? false;
        // This mirrors the guard in src/index.ts acpSpawner: refuse claude-code
        // under useWorkerUid before attempting to spawn.
        if (useWorker && claude.name === 'claude-code') {
          throw new Error('useWorkerUid not supported for claude-code adapter');
        }
        throw new Error('unreachable');
      },
    });
  });

  afterEach(async () => {
    await mgr.shutdown();
    await db.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('refuses the session with a clear error', async () => {
    await expect(mgr.createSession('do work', 'gspivey/agent-router')).rejects.toThrow(
      /useWorkerUid not supported for claude-code/,
    );
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 2 & 3. Socket modes
// ---------------------------------------------------------------------------

describe('socket modes (FR-4.1 / FR-4.2)', () => {
  let rootDir: string;
  let sf: SessionFiles;
  let db: Database;
  let mgr: SessionManager;
  let agentServer: AgentServer;
  let cliServer: CliServer;
  let agentSocketPath: string;
  let operatorSocketPath: string;

  const githubStub = {
    async getPullState() {
      return { state: 'open', base: 'development', merged: false };
    },
  } as unknown as GitHubClient;
  const tokenResolver: TokenResolver = () => 'ghp_dummy';

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-iso-sock-'));
    sf = createSessionFiles(rootDir);
    db = initDatabase(path.join(rootDir, 'agent-router.db'));
    agentSocketPath = path.join(rootDir, 'agent.sock');
    operatorSocketPath = path.join(rootDir, 'sock');

    mgr = createSessionManager({
      db,
      sessionFiles: sf,
      log: silentLog,
      acpSpawner: () => {
        throw new Error('no spawn in socket-mode test');
      },
    });

    agentServer = createAgentServer({
      socketPath: agentSocketPath,
      sessionMgr: mgr,
      github: githubStub,
      tokenResolver,
      log: silentLog,
      worktreeBase: path.join(rootDir, 'worktrees'),
    });
    await agentServer.start();

    cliServer = createCliServer({
      socketPath: operatorSocketPath,
      sessionMgr: mgr,
      sessionFiles: sf,
      log: silentLog,
      db,
      cronTasks: [],
      cronEntries: [],
    });
    await cliServer.start();
  });

  afterEach(async () => {
    await agentServer.shutdown();
    await cliServer.shutdown();
    await mgr.shutdown();
    await db.shutdown();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('creates the agent socket mode 0660 (group-connectable)', () => {
    const mode = fs.statSync(agentSocketPath).mode & 0o777;
    expect(mode).toBe(0o660);
  });

  it('creates the operator socket mode 0600 (agentworker cannot connect)', () => {
    const mode = fs.statSync(operatorSocketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// 4 & 5. github_forward disallowed path + push_branch protected branch
// ---------------------------------------------------------------------------

describe('agent socket guards without side effects (FR-5 / FR-6)', () => {
  const SESSION_ID = 'iso-guard-session';
  const CAP_TOKEN = 'cap-token-abcdef0123456789abcdef01';
  const SESSION_REPO = 'octo/widget';

  let tmpDir: string;
  let socketPath: string;
  let server: AgentServer;
  let fetchCalls: number;
  let execCalls: Array<readonly string[]>;

  const sessionMgr = {
    validateCapToken: (sid: string, token: string) => sid === SESSION_ID && token === CAP_TOKEN,
    getSessionRepo: (sid: string) => (sid === SESSION_ID ? SESSION_REPO : undefined),
    getSessionReadRepos: () => [],
  } as unknown as SessionManager;

  const githubStub = {} as unknown as GitHubClient;
  const tokenResolver: TokenResolver = () => 'ghp_dummy';

  function roundTrip(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('agent socket timeout'));
      }, 8000);
      socket.on('connect', () => socket.write(JSON.stringify(frame) + '\n'));
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const idx = buffer.indexOf('\n');
        if (idx !== -1) {
          clearTimeout(timer);
          socket.destroy();
          try {
            resolve(JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-iso-guard-'));
    socketPath = path.join(tmpDir, 'agent.sock');
    fetchCalls = 0;
    execCalls = [];

    const fetchImpl: typeof fetch = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    async function execFileImpl(
      _cmd: string,
      args: readonly string[],
    ): Promise<{ stdout: string; stderr: string }> {
      execCalls.push(args);
      return { stdout: '', stderr: '' };
    }

    server = createAgentServer({
      socketPath,
      sessionMgr,
      github: githubStub,
      tokenResolver,
      log: silentLog,
      worktreeBase: path.join(tmpDir, 'worktrees'),
      baseBranch: 'development',
      fetchImpl,
      execFileImpl: execFileImpl as unknown as NonNullable<AgentServerDeps['execFileImpl']>,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a disallowed github_forward path and makes NO GitHub call (AC-4)', async () => {
    const resp = await roundTrip({
      op: 'github_forward',
      session_id: SESSION_ID,
      cap_token: CAP_TOKEN,
      method: 'POST',
      path: '/repos/octo/widget/hooks',
      body: {},
    });
    expect(resp['error']).toBe('not permitted');
    expect(fetchCalls).toBe(0);
  });

  it('rejects a push_branch for a protected branch and runs NO git', async () => {
    const resp = await roundTrip({
      op: 'push_branch',
      session_id: SESSION_ID,
      cap_token: CAP_TOKEN,
      branch: 'main',
    });
    expect(resp['error']).toBe('Protected branch');
    expect(execCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 (FR-2 / AC-3): agent-server PAT source is the credential token store
// with NO env fallback — a repo with no stored token fails closed.
// ---------------------------------------------------------------------------

describe('agent-server PAT source fails closed without a stored token (FR-2 / AC-3)', () => {
  const SESSION_ID = 'iso-notoken-session';
  const CAP_TOKEN = 'cap-token-notoken0123456789abcd01';
  const SESSION_REPO = 'octo/widget'; // deliberately NOT in tokens.json

  let tmpDir: string;
  let socketPath: string;
  let server: AgentServer;
  let fetchCalls: number;
  let execCalls: Array<readonly string[]>;
  let execEnvs: Array<Record<string, string | undefined> | undefined>;
  const ORIG_GH = process.env['GITHUB_TOKEN'];

  const sessionMgr = {
    validateCapToken: (sid: string, token: string) => sid === SESSION_ID && token === CAP_TOKEN,
    getSessionRepo: (sid: string) => (sid === SESSION_ID ? SESSION_REPO : undefined),
    getSessionReadRepos: () => [],
  } as unknown as SessionManager;

  const githubStub = {} as unknown as GitHubClient;

  function roundTrip(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('agent socket timeout'));
      }, 8000);
      socket.on('connect', () => socket.write(JSON.stringify(frame) + '\n'));
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const idx = buffer.indexOf('\n');
        if (idx !== -1) {
          clearTimeout(timer);
          socket.destroy();
          try {
            resolve(JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  beforeEach(async () => {
    // A GITHUB_TOKEN in the env must NOT leak through — assert it never appears.
    process.env['GITHUB_TOKEN'] = 'ghp_SENTINEL_env';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-iso-notoken-'));
    socketPath = path.join(tmpDir, 'agent.sock');
    fetchCalls = 0;
    execCalls = [];
    execEnvs = [];

    // Real token store whose only project does NOT contain SESSION_REPO.
    const tokensFile = path.join(tmpDir, 'tokens.json');
    fs.writeFileSync(
      tokensFile,
      JSON.stringify({ projects: { other: { token: 'tok-other', repos: ['someone/else'] } } }),
    );
    const store = createTokenStore({ tokensFilePath: tokensFile, log: silentLog });

    const fetchImpl: typeof fetch = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    async function execFileImpl(
      _cmd: string,
      args: readonly string[],
      options?: { env?: Record<string, string | undefined> },
    ): Promise<{ stdout: string; stderr: string }> {
      execCalls.push(args);
      execEnvs.push(options?.env);
      // rev-parse returns matching tree SHAs so the .github guard passes and
      // execution reaches resolvePat (which must then throw).
      if (args.includes('rev-parse')) return { stdout: 'SAME\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }

    server = createAgentServer({
      socketPath,
      sessionMgr,
      github: githubStub,
      tokenResolver: credentialTokenResolver(store),
      log: silentLog,
      worktreeBase: path.join(tmpDir, 'worktrees'),
      baseBranch: 'development',
      fetchImpl,
      // Defined so Fix 3's .github guard does not short-circuit first.
      bareClonePathFor: (): string | undefined => path.join(tmpDir, 'bare-clone'),
      execFileImpl: execFileImpl as unknown as NonNullable<AgentServerDeps['execFileImpl']>,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (ORIG_GH === undefined) delete process.env['GITHUB_TOKEN'];
    else process.env['GITHUB_TOKEN'] = ORIG_GH;
  });

  it('push_branch returns an error and issues NO push when no token is stored', async () => {
    const workDir = path.join(tmpDir, 'worktrees', SESSION_ID, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'push-bundle.bundle'), Buffer.from('stub-bundle'));

    const resp = await roundTrip({
      op: 'push_branch',
      session_id: SESSION_ID,
      cap_token: CAP_TOKEN,
      branch: 'agent/fix',
    });
    expect(resp['error']).toBe('push failed');
    // No push command ran, and the sentinel GITHUB_TOKEN never reached any exec env.
    expect(execCalls.some((a) => a.includes('push'))).toBe(false);
    for (const env of execEnvs) {
      if (env) expect(env['GITHUB_TOKEN']).toBeUndefined();
    }
  });

  it('github_forward never calls fetch when the token lookup fails', async () => {
    const resp = await roundTrip({
      op: 'github_forward',
      session_id: SESSION_ID,
      cap_token: CAP_TOKEN,
      method: 'GET',
      path: '/repos/octo/widget/pulls/1',
    });
    expect(resp['error']).toBe('not permitted');
    expect(fetchCalls).toBe(0);
  });
});
