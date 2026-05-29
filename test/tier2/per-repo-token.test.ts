/**
 * Tier 2 tests: per-repo GitHub PAT reaches the wire.
 *
 * Wires the real GitHubClient (with a config-built tokenResolver) to a real
 * HTTP FakeGitHubBackend, then asserts each repo's call carries its own
 * Authorization: Bearer header. This is the integration that "MCP follows
 * the hierarchy" depends on — the MCP tools reach GitHub through this same
 * client, so per-repo correctness here covers the whole call surface.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeGitHubBackend } from '../harness/fake-github.js';
import { createGitHubClient, createTokenResolver } from '../../src/github.js';

let backend: FakeGitHubBackend;

beforeEach(async () => {
  backend = new FakeGitHubBackend('unused-webhook-secret');
  await backend.start();
});

afterEach(async () => {
  await backend.stop();
});

describe('per-repo token reaches GitHub', () => {
  it('sends repo-specific token when configured, default for others', async () => {
    // Two repos, one with an override.
    await backend.createInitialPR('gspivey/dpdk-stdlib-rust', 'feat/x', 'PR1', '');
    await backend.createInitialPR('gspivey/agent-router', 'feat/y', 'PR2', '');

    const tokenResolver = createTokenResolver({
      perRepoTokens: { 'gspivey/dpdk-stdlib-rust': 'tok-dpdk' },
      defaultToken: 'tok-default',
    });
    const github = createGitHubClient({ baseUrl: backend.apiBaseUrl(), tokenResolver });

    await github.getPullState('gspivey', 'dpdk-stdlib-rust', 1);
    await github.getPullState('gspivey', 'agent-router', 2);

    const calls = await backend.getAPICalls();
    const dpdkCall = calls.find((c) => c.path === '/repos/gspivey/dpdk-stdlib-rust/pulls/1');
    const arCall = calls.find((c) => c.path === '/repos/gspivey/agent-router/pulls/2');

    expect(dpdkCall?.headers['authorization']).toBe('Bearer tok-dpdk');
    expect(arCall?.headers['authorization']).toBe('Bearer tok-default');
  }, 15_000);

  it('two repos with distinct overrides both reach the wire with the right token', async () => {
    await backend.createInitialPR('gspivey/repo-a', 'a', 'A', '');
    await backend.createInitialPR('gspivey/repo-b', 'b', 'B', '');

    const tokenResolver = createTokenResolver({
      perRepoTokens: {
        'gspivey/repo-a': 'tok-a',
        'gspivey/repo-b': 'tok-b',
      },
    });
    const github = createGitHubClient({ baseUrl: backend.apiBaseUrl(), tokenResolver });

    await github.getPullState('gspivey', 'repo-a', 1);
    await github.getPullState('gspivey', 'repo-b', 2);

    const calls = await backend.getAPICalls();
    const a = calls.find((c) => c.path === '/repos/gspivey/repo-a/pulls/1');
    const b = calls.find((c) => c.path === '/repos/gspivey/repo-b/pulls/2');

    expect(a?.headers['authorization']).toBe('Bearer tok-a');
    expect(b?.headers['authorization']).toBe('Bearer tok-b');
  }, 15_000);
});
