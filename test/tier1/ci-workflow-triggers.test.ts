import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('CI workflow triggers', () => {
  const ciYml = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');

  it('pull_request trigger targets development, not main', () => {
    // The pull_request trigger must fire for PRs targeting development
    // (all agent PRs target development per the branch model)
    const prSection = ciYml.match(/pull_request:\s*\n\s*branches:\s*\[([^\]]+)\]/);
    expect(prSection).not.toBeNull();
    const branches = prSection![1]!;
    expect(branches).toContain('development');
    expect(branches).not.toMatch(/\bmain\b/);
  });

  it('push trigger includes development branch', () => {
    const pushSection = ciYml.match(/push:\s*\n\s*branches:\s*\[([^\]]+)\]/);
    expect(pushSection).not.toBeNull();
    const branches = pushSection![1]!;
    expect(branches).toContain('development');
  });

  describe('tier3-nightly workflow', () => {
    const nightlyYml = readFileSync(
      resolve(ROOT, '.github/workflows/tier3-nightly.yml'),
      'utf8',
    );

    it('checks out development branch explicitly', () => {
      // Scheduled workflows always check out the default branch (main)
      // unless ref is specified — nightly must test development
      expect(nightlyYml).toContain('ref: development');
    });
  });
});
