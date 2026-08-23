/**
 * Tier 1 tests: getTokenHealthSummary — pure logic.
 * Spec: .kiro/specs/web-ui-config-view/ · task 1b
 */
import { describe, it, expect } from 'vitest';
import { getTokenHealthSummary, deriveTokenHealth } from '../../src/token-store.js';
import type { TokenMap, ProjectEntry } from '../../src/token-store.js';
import { Secret } from '../../src/secret.js';

function makeEntry(opts: {
  name: string;
  expiresAt?: Date;
}): ProjectEntry {
  return {
    name: opts.name,
    token: Secret.of('ghp_test_token_' + opts.name),
    repos: [`owner/${opts.name}`],
    expiresAt: opts.expiresAt,
  };
}

function makeTokenMap(entries: ProjectEntry[]): TokenMap {
  const projects = new Map(entries.map(e => [e.name, e]));
  const repoIndex = new Map<string, string>();
  for (const e of entries) {
    for (const r of e.repos) {
      repoIndex.set(r, e.name);
    }
  }
  return { projects, repoIndex };
}

describe('deriveTokenHealth', () => {
  const now = new Date('2026-08-23T12:00:00Z');

  it('returns red when entry is undefined', () => {
    expect(deriveTokenHealth(undefined, now)).toBe('red');
  });

  it('returns green when token present and no expiry', () => {
    const entry = makeEntry({ name: 'proj1' });
    expect(deriveTokenHealth(entry, now)).toBe('green');
  });

  it('returns green when token present and expiry is in the future', () => {
    const entry = makeEntry({
      name: 'proj1',
      expiresAt: new Date('2027-01-15T00:00:00Z'),
    });
    expect(deriveTokenHealth(entry, now)).toBe('green');
  });

  it('returns red when token present and expiry is in the past', () => {
    const entry = makeEntry({
      name: 'proj1',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(deriveTokenHealth(entry, now)).toBe('red');
  });

  it('returns red when expiry equals now exactly', () => {
    const entry = makeEntry({
      name: 'proj1',
      expiresAt: new Date('2026-08-23T12:00:00Z'),
    });
    // expiresAt.getTime() > now.getTime() is false when equal, so red
    expect(deriveTokenHealth(entry, now)).toBe('red');
  });
});

describe('getTokenHealthSummary', () => {
  const now = new Date('2026-08-23T12:00:00Z');

  it('returns empty array for empty token map', () => {
    const map = makeTokenMap([]);
    expect(getTokenHealthSummary(map, now)).toEqual([]);
  });

  it('returns green entry for token present with no expiry', () => {
    const entry = makeEntry({ name: 'myproject' });
    const map = makeTokenMap([entry]);

    const result = getTokenHealthSummary(map, now);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      project: 'myproject',
      tokenName: 'myproject',
      isSet: true,
      expiry: null,
      health: 'green',
    });
  });

  it('returns green entry for token with future expiry', () => {
    const entry = makeEntry({
      name: 'proj-future',
      expiresAt: new Date('2027-06-01T00:00:00Z'),
    });
    const map = makeTokenMap([entry]);

    const result = getTokenHealthSummary(map, now);
    expect(result).toHaveLength(1);
    expect(result[0]!.health).toBe('green');
    expect(result[0]!.expiry).toBe('2027-06-01T00:00:00.000Z');
  });

  it('returns red entry for token with past expiry', () => {
    const entry = makeEntry({
      name: 'proj-expired',
      expiresAt: new Date('2025-12-31T23:59:59Z'),
    });
    const map = makeTokenMap([entry]);

    const result = getTokenHealthSummary(map, now);
    expect(result).toHaveLength(1);
    expect(result[0]!.health).toBe('red');
    expect(result[0]!.isSet).toBe(true);
    expect(result[0]!.expiry).toBe('2025-12-31T23:59:59.000Z');
  });

  it('handles multiple projects correctly', () => {
    const entries = [
      makeEntry({ name: 'healthy' }),
      makeEntry({ name: 'expired', expiresAt: new Date('2020-01-01T00:00:00Z') }),
      makeEntry({ name: 'future', expiresAt: new Date('2028-01-01T00:00:00Z') }),
    ];
    const map = makeTokenMap(entries);

    const result = getTokenHealthSummary(map, now);
    expect(result).toHaveLength(3);

    const healthMap = new Map(result.map(r => [r.project, r.health]));
    expect(healthMap.get('healthy')).toBe('green');
    expect(healthMap.get('expired')).toBe('red');
    expect(healthMap.get('future')).toBe('green');
  });
});
