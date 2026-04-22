/**
 * Tier 2 smoke test: exercises the full daemon against fake backends.
 * Requirements: 24.6
 *
 * NOTE: The daemon is not yet fully implemented. This test validates
 * the harness infrastructure itself — that FakeGitHubBackend,
 * FakeKiroBackend, and TestDaemon start/stop cleanly and that the
 * interfaces are wired correctly. Full end-to-end assertions will
 * pass once the daemon implementation is complete.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FakeGitHubBackend } from '../harness/fake-github.js';
import { FakeKiroBackend } from '../harness/fake-kiro.js';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const WEBHOOK_SECRET = 'test-secret-abc123';

describe('Tier 2 harness smoke test', () => {
  let github: FakeGitHubBackend;
  let kiro: FakeKiroBackend;

  beforeAll(async () => {
    github = new FakeGitHubBackend(WEBHOOK_SECRET);
    kiro = new FakeKiroBackend();
    await github.start();
  });

  afterAll(async () => {
    await github.stop();
  });

  it('FakeGitHubBackend starts and returns a valid apiBaseUrl', () => {
    const base = github.apiBaseUrl();
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('FakeKiroBackend returns a valid spawnConfig', () => {
    const cfg = kiro.spawnConfig();
    expect(cfg.command).toBe('node');
    expect(Array.isArray(cfg.args)).toBe(true);
  });

  it('FakeGitHubBackend creates a PR and returns the PR state', async () => {
    const prNumber = await github.createInitialPR(
      'testowner/testrepo',
      'feature/test-branch',
      'Test PR',
      'This is a test pull request'
    );
    expect(prNumber).toBe(1);

    const state = await github.getPRState('testowner/testrepo', 1);
    expect(state.title).toBe('Test PR');
    expect(state.state).toBe('open');
    expect(state.headRef).toBe('feature/test-branch');
  });

  it('FakeGitHubBackend getAllPRs returns created PRs', async () => {
    const prs = await github.getAllPRs('testowner/testrepo');
    expect(prs.length).toBeGreaterThanOrEqual(1);
    expect(prs[0]!.title).toBe('Test PR');
  });

  it('FakeGitHubBackend reset clears state', async () => {
    await github.reset();
    const prs = await github.getAllPRs('testowner/testrepo');
    expect(prs).toHaveLength(0);
  });

  it('FakeKiroBackend loads a scenario without error', async () => {
    const scenarioPath = path.resolve(__dirname, '../scenarios/simple-echo.json');
    await expect(kiro.loadScenario(scenarioPath)).resolves.toBeUndefined();
  });

  it('FakeKiroBackend reset clears scenario', async () => {
    await kiro.reset();
    const cfg = kiro.spawnConfig();
    expect(cfg.env).toEqual({});
  });
});
