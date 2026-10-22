/**
 * Tier 1 tests: config-derived credential token store (single PAT source).
 */
import { describe, it, expect } from 'vitest';
import {
  buildConfigTokenMap,
  configProjectName,
  createConfigTokenStore,
  type ConfigTokenRepo,
} from '../../src/config-token-store.js';
import { credentialTokenResolver } from '../../src/token-resolver.js';

const REPOS: ConfigTokenRepo[] = [
  { owner: 'acme', name: 'widget', token: 'tok-widget' },
  { owner: 'acme', name: 'gadget', token: 'tok-gadget' },
  { owner: 'acme', name: 'no-token' },
  { owner: 'acme', name: 'empty-token', token: '' },
];

describe('buildConfigTokenMap', () => {
  it('creates one project per repo with a token, scoped to that repo only', () => {
    const map = buildConfigTokenMap(REPOS);
    expect(map.projects.size).toBe(2);
    const widget = map.projects.get(configProjectName('acme', 'widget'));
    expect(widget?.repos).toEqual(['acme/widget']);
    expect(widget?.token.reveal()).toBe('tok-widget');
    expect(map.repoIndex.get('acme/gadget')).toBe(configProjectName('acme', 'gadget'));
  });

  it('skips repos with no or empty token', () => {
    const map = buildConfigTokenMap(REPOS);
    expect(map.repoIndex.has('acme/no-token')).toBe(false);
    expect(map.repoIndex.has('acme/empty-token')).toBe(false);
  });
});

describe('credentialTokenResolver over the config store', () => {
  it('returns the repo’s own configured token', () => {
    const resolve = credentialTokenResolver(createConfigTokenStore(() => REPOS));
    expect(resolve('acme', 'widget')).toBe('tok-widget');
    expect(resolve('acme', 'gadget')).toBe('tok-gadget');
  });

  it('fails closed for a repo without a token (no default / ambient fallback)', () => {
    const prev = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'ambient-should-not-be-used';
    try {
      const resolve = credentialTokenResolver(createConfigTokenStore(() => REPOS));
      expect(() => resolve('acme', 'no-token')).toThrow('No token configured for repo acme/no-token');
      expect(() => resolve('other', 'repo')).toThrow('No token configured for repo other/repo');
    } finally {
      if (prev === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = prev;
    }
  });
});

describe('createConfigTokenStore reload', () => {
  it('picks up a rotated token from the current config and reports the change', () => {
    let repos: ConfigTokenRepo[] = [{ owner: 'acme', name: 'widget', token: 'old' }];
    const store = createConfigTokenStore(() => repos);
    const resolve = credentialTokenResolver(store);
    expect(resolve('acme', 'widget')).toBe('old');

    expect(store.reload()).toBe(false); // unchanged config

    repos = [{ owner: 'acme', name: 'widget', token: 'new' }];
    expect(store.reload()).toBe(true);
    expect(resolve('acme', 'widget')).toBe('new');
  });
});
