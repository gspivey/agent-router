/**
 * Tier 1 tests for src/token-store.ts
 *
 * Covers:
 *  - Property 1: Tokens file round-trip (serializeTokenMap → parseTokensFile)
 *  - Property 2: Project entry validation
 *  - Property 3: Repo uniqueness invariant
 *  - Property 7: Reload diff correctness
 *  - Property 9: Project name validation
 *  - Property 10: Expiry warning tiers
 *  - Unit tests for edge cases (invalid JSON, missing fields, duplicate repos)
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  isValidProjectName,
  isValidRepoString,
  validateProjectEntry,
  validateRepoUniqueness,
  parseTokensFile,
  computeReloadDiff,
  evaluateExpiryWarnings,
  serializeTokenMap,
} from '../../src/token-store.js';
import type { ProjectEntry, TokenMap } from '../../src/token-store.js';
import { Secret } from '../../src/secret.js';
import { FatalError } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a valid project name: 1+ ASCII chars from [a-zA-Z0-9._-] */
const arbProjectName = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'.split('')),
  { minLength: 1, maxLength: 20 }
);

/** Generate a valid repo segment (owner or repo part) */
const arbRepoSegment = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'.split('')),
  { minLength: 1, maxLength: 15 }
);

/** Generate a valid repo string: owner/repo */
const arbRepoString = fc.tuple(arbRepoSegment, arbRepoSegment).map(([o, r]) => `${o}/${r}`);

/** Generate a non-empty token string (prefixed for realism) */
const arbToken = fc.string({ minLength: 1, maxLength: 40 }).map(s => `github_pat_${s}`);

/** Generate a valid ISO 8601 date string */
const arbExpiresAt = fc.date({
  min: new Date('2020-01-01T00:00:00Z'),
  max: new Date('2030-12-31T23:59:59Z'),
}).map(d => d.toISOString());

/** Generate a single valid project entry (raw JSON object form) */
const arbProjectEntryRaw = fc.record({
  token: arbToken,
  repos: fc.uniqueArray(arbRepoString, { minLength: 1, maxLength: 5 }),
  expires_at: fc.option(arbExpiresAt, { nil: undefined }),
}).map(e => {
  const result: Record<string, unknown> = { token: e.token, repos: e.repos };
  if (e.expires_at !== undefined) result['expires_at'] = e.expires_at;
  return result;
});

/**
 * Generate a valid TokenMap with globally unique repos.
 * We generate 1-4 projects, each with unique repos (no overlap).
 */
const arbTokenMap: fc.Arbitrary<TokenMap> = fc.integer({ min: 1, max: 4 }).chain(numProjects => {
  return fc.tuple(
    fc.uniqueArray(arbProjectName, { minLength: numProjects, maxLength: numProjects }),
    fc.array(arbToken, { minLength: numProjects, maxLength: numProjects }),
    fc.array(
      fc.uniqueArray(arbRepoString, { minLength: 1, maxLength: 3 }),
      { minLength: numProjects, maxLength: numProjects }
    ),
    fc.array(
      fc.option(fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }), { nil: undefined }),
      { minLength: numProjects, maxLength: numProjects }
    ),
  ).map(([names, tokens, repoArrays, expiryDates]) => {
    // Ensure repos are globally unique across projects
    const usedRepos = new Set<string>();
    const projects = new Map<string, ProjectEntry>();
    const repoIndex = new Map<string, string>();

    for (let i = 0; i < numProjects; i++) {
      const name = names[i]!;
      const token = tokens[i]!;
      const rawRepos = repoArrays[i]!;
      const expiresAt = expiryDates[i];

      // Filter to repos not used by other projects
      const uniqueRepos = rawRepos.filter(r => !usedRepos.has(r));
      if (uniqueRepos.length === 0) {
        // Generate a guaranteed unique repo
        uniqueRepos.push(`gen-owner-${i}/gen-repo-${i}`);
      }
      for (const r of uniqueRepos) usedRepos.add(r);

      const entry: ProjectEntry = {
        name,
        token: Secret.of(token),
        repos: uniqueRepos,
        expiresAt,
      };
      projects.set(name, entry);
      for (const r of uniqueRepos) repoIndex.set(r, name);
    }

    return { projects, repoIndex };
  });
});

// ---------------------------------------------------------------------------
// Property 1: Tokens file round-trip
// Feature: auth-credential-proxy, Property 1: Tokens file round-trip
// ---------------------------------------------------------------------------
describe('Property 1: Tokens file round-trip', () => {
  it('serialize → parse produces same project keys, tokens, repos, and expiry dates', () => {
    fc.assert(
      fc.property(arbTokenMap, (map) => {
        const serialized = serializeTokenMap(map);
        const reparsed = parseTokensFile(serialized);

        // Same project keys
        const originalKeys = [...map.projects.keys()].sort();
        const reparsedKeys = [...reparsed.projects.keys()].sort();
        expect(reparsedKeys).toEqual(originalKeys);

        // Same token values, repo lists, and expiry dates per project
        for (const [name, original] of map.projects) {
          const restored = reparsed.projects.get(name);
          expect(restored).toBeDefined();
          expect(restored!.token.reveal()).toBe(original.token.reveal());
          expect([...restored!.repos]).toEqual([...original.repos]);

          // Expiry date comparison: both undefined, or same timestamp
          if (original.expiresAt === undefined) {
            expect(restored!.expiresAt).toBeUndefined();
          } else {
            expect(restored!.expiresAt).toBeDefined();
            // ISO round-trip may lose sub-millisecond precision but Date objects compare equal
            expect(restored!.expiresAt!.getTime()).toBe(original.expiresAt.getTime());
          }
        }

        // Repo index is identical
        expect([...reparsed.repoIndex.entries()].sort()).toEqual(
          [...map.repoIndex.entries()].sort()
        );
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Project entry validation
// Feature: auth-credential-proxy, Property 2: Project entry validation
// ---------------------------------------------------------------------------
describe('Property 2: Project entry validation', () => {
  it('accepts entries with non-empty token and valid non-empty repos array', () => {
    fc.assert(
      fc.property(arbProjectName, arbProjectEntryRaw, (name, entry) => {
        // All generated entries are valid by construction
        const result = validateProjectEntry(name, entry);
        expect(result.name).toBe(name);
        expect(result.token.reveal()).toBe(entry['token']);
        expect([...result.repos]).toEqual(entry['repos']);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects entries with empty token', () => {
    fc.assert(
      fc.property(arbProjectName, arbProjectEntryRaw, (name, entry) => {
        const invalid = { ...entry, token: '' };
        expect(() => validateProjectEntry(name, invalid)).toThrow(FatalError);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects entries with empty repos array', () => {
    fc.assert(
      fc.property(arbProjectName, arbProjectEntryRaw, (name, entry) => {
        const invalid = { ...entry, repos: [] };
        expect(() => validateProjectEntry(name, invalid)).toThrow(FatalError);
      }),
      { numRuns: 100 }
    );
  });

  it('rejects entries with invalid repo format', () => {
    fc.assert(
      fc.property(
        arbProjectName,
        arbToken,
        fc.string({ minLength: 1 }).filter(s => !isValidRepoString(s)),
        (name, token, badRepo) => {
          const entry = { token, repos: [badRepo] };
          expect(() => validateProjectEntry(name, entry)).toThrow(FatalError);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Repo uniqueness invariant
// Feature: auth-credential-proxy, Property 3: Repo uniqueness invariant
// ---------------------------------------------------------------------------
describe('Property 3: Repo uniqueness invariant', () => {
  it('does not throw when all repos are globally unique', () => {
    fc.assert(
      fc.property(arbTokenMap, (map) => {
        // arbTokenMap guarantees unique repos, so this should not throw
        expect(() => validateRepoUniqueness(map.projects)).not.toThrow();
      }),
      { numRuns: 100 }
    );
  });

  it('throws FatalError when a repo appears in two projects', () => {
    fc.assert(
      fc.property(
        arbProjectName,
        arbProjectName.filter(n2 => n2.length > 0),
        arbToken,
        arbToken,
        arbRepoString,
        (name1, name2Raw, token1, token2, sharedRepo) => {
          // Ensure distinct project names
          const name2 = name1 === name2Raw ? `${name2Raw}x` : name2Raw;
          if (!isValidProjectName(name2)) return; // skip if concat makes it invalid

          const projects = new Map<string, ProjectEntry>([
            [name1, { name: name1, token: Secret.of(token1), repos: [sharedRepo], expiresAt: undefined }],
            [name2, { name: name2, token: Secret.of(token2), repos: [sharedRepo], expiresAt: undefined }],
          ]);

          expect(() => validateRepoUniqueness(projects)).toThrow(FatalError);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('error message identifies the duplicate repo and conflicting projects', () => {
    const projects = new Map<string, ProjectEntry>([
      ['proj-a', { name: 'proj-a', token: Secret.of('tok1'), repos: ['owner/shared'], expiresAt: undefined }],
      ['proj-b', { name: 'proj-b', token: Secret.of('tok2'), repos: ['owner/shared'], expiresAt: undefined }],
    ]);

    expect(() => validateRepoUniqueness(projects)).toThrow(/owner\/shared/);
    expect(() => validateRepoUniqueness(projects)).toThrow(/proj-a/);
    expect(() => validateRepoUniqueness(projects)).toThrow(/proj-b/);
  });
});

// ---------------------------------------------------------------------------
// Property 7: Reload diff correctness
// Feature: auth-credential-proxy, Property 7: Reload diff correctness
// ---------------------------------------------------------------------------
describe('Property 7: Reload diff correctness', () => {
  it('partitions all project names into added/removed/changed/unchanged correctly', () => {
    fc.assert(
      fc.property(arbTokenMap, arbTokenMap, (oldMap, newMap) => {
        const diff = computeReloadDiff(oldMap, newMap);

        const allOldNames = new Set(oldMap.projects.keys());
        const allNewNames = new Set(newMap.projects.keys());

        // added: in new but not in old
        for (const name of diff.added) {
          expect(allNewNames.has(name)).toBe(true);
          expect(allOldNames.has(name)).toBe(false);
        }
        // removed: in old but not in new
        for (const name of diff.removed) {
          expect(allOldNames.has(name)).toBe(true);
          expect(allNewNames.has(name)).toBe(false);
        }
        // changed/unchanged: in both
        for (const name of diff.changed) {
          expect(allOldNames.has(name)).toBe(true);
          expect(allNewNames.has(name)).toBe(true);
        }
        for (const name of diff.unchanged) {
          expect(allOldNames.has(name)).toBe(true);
          expect(allNewNames.has(name)).toBe(true);
        }

        // Union of all four partitions == union of all names from both maps
        const allFromDiff = new Set([
          ...diff.added,
          ...diff.removed,
          ...diff.changed,
          ...diff.unchanged,
        ]);
        const expectedAll = new Set([...allOldNames, ...allNewNames]);
        expect([...allFromDiff].sort()).toEqual([...expectedAll].sort());

        // No name appears in more than one partition
        const totalCount = diff.added.length + diff.removed.length +
          diff.changed.length + diff.unchanged.length;
        expect(totalCount).toBe(allFromDiff.size);
      }),
      { numRuns: 100 }
    );
  });

  it('marks a project as unchanged when token and repos are identical', () => {
    const entry: ProjectEntry = {
      name: 'proj', token: Secret.of('tok'), repos: ['o/r'], expiresAt: undefined,
    };
    const map: TokenMap = {
      projects: new Map([['proj', entry]]),
      repoIndex: new Map([['o/r', 'proj']]),
    };
    const diff = computeReloadDiff(map, map);
    expect(diff.unchanged).toContain('proj');
    expect(diff.changed).not.toContain('proj');
  });

  it('marks a project as changed when its token changes', () => {
    const entry1: ProjectEntry = { name: 'proj', token: Secret.of('tok1'), repos: ['o/r'], expiresAt: undefined };
    const entry2: ProjectEntry = { name: 'proj', token: Secret.of('tok2'), repos: ['o/r'], expiresAt: undefined };
    const oldMap: TokenMap = { projects: new Map([['proj', entry1]]), repoIndex: new Map([['o/r', 'proj']]) };
    const newMap: TokenMap = { projects: new Map([['proj', entry2]]), repoIndex: new Map([['o/r', 'proj']]) };
    const diff = computeReloadDiff(oldMap, newMap);
    expect(diff.changed).toContain('proj');
    expect(diff.unchanged).not.toContain('proj');
  });

  it('marks a project as changed when its repos change', () => {
    const entry1: ProjectEntry = { name: 'proj', token: Secret.of('tok'), repos: ['o/r1'], expiresAt: undefined };
    const entry2: ProjectEntry = { name: 'proj', token: Secret.of('tok'), repos: ['o/r1', 'o/r2'], expiresAt: undefined };
    const oldMap: TokenMap = { projects: new Map([['proj', entry1]]), repoIndex: new Map([['o/r1', 'proj']]) };
    const newMap: TokenMap = { projects: new Map([['proj', entry2]]), repoIndex: new Map([['o/r1', 'proj'], ['o/r2', 'proj']]) };
    const diff = computeReloadDiff(oldMap, newMap);
    expect(diff.changed).toContain('proj');
  });

  it('marks a project as added when it appears only in new map', () => {
    const oldMap: TokenMap = { projects: new Map(), repoIndex: new Map() };
    const entry: ProjectEntry = { name: 'new-proj', token: Secret.of('tok'), repos: ['o/r'], expiresAt: undefined };
    const newMap: TokenMap = {
      projects: new Map([['new-proj', entry]]),
      repoIndex: new Map([['o/r', 'new-proj']]),
    };
    const diff = computeReloadDiff(oldMap, newMap);
    expect(diff.added).toContain('new-proj');
  });

  it('marks a project as removed when it appears only in old map', () => {
    const entry: ProjectEntry = { name: 'old-proj', token: Secret.of('tok'), repos: ['o/r'], expiresAt: undefined };
    const oldMap: TokenMap = {
      projects: new Map([['old-proj', entry]]),
      repoIndex: new Map([['o/r', 'old-proj']]),
    };
    const newMap: TokenMap = { projects: new Map(), repoIndex: new Map() };
    const diff = computeReloadDiff(oldMap, newMap);
    expect(diff.removed).toContain('old-proj');
  });
});

// ---------------------------------------------------------------------------
// Property 9: Project name validation
// Feature: auth-credential-proxy, Property 9: Project name validation
// ---------------------------------------------------------------------------
describe('Property 9: Project name validation', () => {
  it('returns true for non-empty strings matching ^[a-zA-Z0-9._-]+$', () => {
    fc.assert(
      fc.property(arbProjectName, (name) => {
        expect(isValidProjectName(name)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('returns false for empty string', () => {
    expect(isValidProjectName('')).toBe(false);
  });

  it('returns false for strings with spaces', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter(s => s.includes(' ')),
        (name) => {
          expect(isValidProjectName(name)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns false for strings with special characters outside the allowed set', () => {
    const invalidChars = ['/', '\\', '@', '#', '$', '%', '^', '&', '*', '!', '?', ' ', '\t', '\n'];
    for (const ch of invalidChars) {
      expect(isValidProjectName(`valid${ch}name`)).toBe(false);
    }
  });

  it('correctly classifies arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const expected = s.length > 0 && /^[a-zA-Z0-9._-]+$/.test(s);
        expect(isValidProjectName(s)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// isValidRepoString additional coverage
// ---------------------------------------------------------------------------
describe('isValidRepoString', () => {
  it('returns true for valid owner/repo strings', () => {
    fc.assert(
      fc.property(arbRepoString, (repo) => {
        expect(isValidRepoString(repo)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('returns false for strings without a slash', () => {
    expect(isValidRepoString('noslash')).toBe(false);
  });

  it('returns false for strings with multiple slashes', () => {
    expect(isValidRepoString('a/b/c')).toBe(false);
  });

  it('returns false for empty owner or repo', () => {
    expect(isValidRepoString('/repo')).toBe(false);
    expect(isValidRepoString('owner/')).toBe(false);
  });

  it('returns false for strings with invalid characters', () => {
    expect(isValidRepoString('owner/re po')).toBe(false);
    expect(isValidRepoString('own@er/repo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 10: Expiry warning tiers
// Feature: auth-credential-proxy, Property 10: Expiry warning tiers
// ---------------------------------------------------------------------------
describe('Property 10: Expiry warning tiers', () => {
  /** Helper: create a project map with one entry expiring at a given date */
  function makeProjectMap(expiresAt: Date): ReadonlyMap<string, ProjectEntry> {
    return new Map([
      ['test-proj', {
        name: 'test-proj',
        token: Secret.of('tok'),
        repos: ['o/r'],
        expiresAt,
      }],
    ]);
  }

  it('emits error for expired tokens (days ≤ 0)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 365 }),
        (daysAgo) => {
          const now = new Date('2026-06-15T12:00:00Z');
          const expiresAt = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
          const warnings = evaluateExpiryWarnings(makeProjectMap(expiresAt), now);
          expect(warnings.length).toBe(1);
          expect(warnings[0]!.level).toBe('error');
          expect(warnings[0]!.alert).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('emits error for tokens expiring in ≤ 2 days', () => {
    fc.assert(
      fc.property(
        // 1-2 days ahead (daysUntilExpiry will be 1 or 2 with Math.ceil)
        fc.integer({ min: 1, max: 2 * 24 * 60 }),
        (minutesAhead) => {
          const now = new Date('2026-06-15T12:00:00Z');
          // Place expiry 1 minute to 2 days ahead
          const expiresAt = new Date(now.getTime() + minutesAhead * 60 * 1000);
          const warnings = evaluateExpiryWarnings(makeProjectMap(expiresAt), now);
          if (warnings.length === 0) return; // > 14 days somehow (shouldn't happen)
          const daysUntil = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
          if (daysUntil <= 2) {
            expect(warnings[0]!.level).toBe('error');
            expect(warnings[0]!.alert).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('emits warn+alert for tokens expiring in 3-7 days', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 7 }),
        (days) => {
          const now = new Date('2026-06-15T12:00:00Z');
          // Place expiry exactly `days` days minus 1 hour to ensure Math.ceil gives `days`
          const expiresAt = new Date(now.getTime() + (days - 1) * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000);
          const warnings = evaluateExpiryWarnings(makeProjectMap(expiresAt), now);
          expect(warnings.length).toBe(1);
          const daysUntil = warnings[0]!.daysUntilExpiry;
          if (daysUntil >= 3 && daysUntil <= 7) {
            expect(warnings[0]!.level).toBe('warn');
            expect(warnings[0]!.alert).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('emits warn (no alert) for tokens expiring in 8-14 days', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: 14 }),
        (days) => {
          const now = new Date('2026-06-15T12:00:00Z');
          // Exactly days-0.5 days ahead → ceil gives `days`
          const expiresAt = new Date(now.getTime() + (days - 1) * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000);
          const warnings = evaluateExpiryWarnings(makeProjectMap(expiresAt), now);
          expect(warnings.length).toBe(1);
          const daysUntil = warnings[0]!.daysUntilExpiry;
          if (daysUntil >= 8 && daysUntil <= 14) {
            expect(warnings[0]!.level).toBe('warn');
            expect(warnings[0]!.alert).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('emits no warning for tokens expiring in > 14 days', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 15, max: 365 }),
        (days) => {
          const now = new Date('2026-06-15T12:00:00Z');
          const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
          const warnings = evaluateExpiryWarnings(makeProjectMap(expiresAt), now);
          expect(warnings.length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('skips projects without expires_at', () => {
    const projects = new Map<string, ProjectEntry>([
      ['no-expiry', { name: 'no-expiry', token: Secret.of('tok'), repos: ['o/r'], expiresAt: undefined }],
    ]);
    const warnings = evaluateExpiryWarnings(projects, new Date());
    expect(warnings.length).toBe(0);
  });

  it('handles multiple projects with mixed expiry states', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const projects = new Map<string, ProjectEntry>([
      ['expired', { name: 'expired', token: Secret.of('t1'), repos: ['o/r1'], expiresAt: new Date('2026-06-10T00:00:00Z') }],
      ['soon', { name: 'soon', token: Secret.of('t2'), repos: ['o/r2'], expiresAt: new Date('2026-06-17T00:00:00Z') }],
      ['safe', { name: 'safe', token: Secret.of('t3'), repos: ['o/r3'], expiresAt: new Date('2026-12-01T00:00:00Z') }],
      ['no-date', { name: 'no-date', token: Secret.of('t4'), repos: ['o/r4'], expiresAt: undefined }],
    ]);
    const warnings = evaluateExpiryWarnings(projects, now);
    // expired + soon = 2 warnings; safe and no-date produce none
    expect(warnings.length).toBe(2);
    const names = warnings.map(w => w.projectName);
    expect(names).toContain('expired');
    expect(names).toContain('soon');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: parseTokensFile edge cases
// ---------------------------------------------------------------------------
describe('parseTokensFile — edge cases', () => {
  it('throws FatalError on invalid JSON', () => {
    expect(() => parseTokensFile('not json at all')).toThrow(FatalError);
    expect(() => parseTokensFile('{invalid')).toThrow(FatalError);
  });

  it('throws FatalError when root is not an object', () => {
    expect(() => parseTokensFile('"string"')).toThrow(FatalError);
    expect(() => parseTokensFile('42')).toThrow(FatalError);
    expect(() => parseTokensFile('null')).toThrow(FatalError);
    expect(() => parseTokensFile('[]')).toThrow(FatalError);
  });

  it('throws FatalError when "projects" key is missing', () => {
    expect(() => parseTokensFile('{}')).toThrow(FatalError);
    expect(() => parseTokensFile('{"other": 1}')).toThrow(FatalError);
  });

  it('throws FatalError when "projects" is an array', () => {
    expect(() => parseTokensFile('{"projects": []}')).toThrow(FatalError);
  });

  it('throws FatalError when "projects" is null', () => {
    expect(() => parseTokensFile('{"projects": null}')).toThrow(FatalError);
  });

  it('accepts empty projects object (no projects)', () => {
    const map = parseTokensFile('{"projects": {}}');
    expect(map.projects.size).toBe(0);
    expect(map.repoIndex.size).toBe(0);
  });

  it('throws FatalError for invalid project name', () => {
    const json = JSON.stringify({
      projects: { 'bad name!': { token: 'tok', repos: ['o/r'] } },
    });
    expect(() => parseTokensFile(json)).toThrow(FatalError);
    expect(() => parseTokensFile(json)).toThrow(/bad name!/);
  });

  it('throws FatalError for missing token', () => {
    const json = JSON.stringify({
      projects: { proj: { repos: ['o/r'] } },
    });
    expect(() => parseTokensFile(json)).toThrow(FatalError);
    expect(() => parseTokensFile(json)).toThrow(/token/);
  });

  it('throws FatalError for non-string token', () => {
    const json = JSON.stringify({
      projects: { proj: { token: 123, repos: ['o/r'] } },
    });
    expect(() => parseTokensFile(json)).toThrow(FatalError);
  });

  it('throws FatalError for missing repos', () => {
    const json = JSON.stringify({
      projects: { proj: { token: 'tok' } },
    });
    expect(() => parseTokensFile(json)).toThrow(FatalError);
    expect(() => parseTokensFile(json)).toThrow(/repos/);
  });

  it('throws FatalError for empty repos array', () => {
    const json = JSON.stringify({
      projects: { proj: { token: 'tok', repos: [] } },
    });
    expect(() => parseTokensFile(json)).toThrow(FatalError);
  });

  it('throws FatalError for invalid repo format in repos array', () => {
    const json = JSON.stringify({
      projects: { proj: { token: 'tok', repos: ['not-a-repo'] } },
    });
    expect(() => parseTokensFile(json)).toThrow(FatalError);
    expect(() => parseTokensFile(json)).toThrow(/not-a-repo/);
  });

  it('throws FatalError for invalid expires_at', () => {
    const json = JSON.stringify({
      projects: { proj: { token: 'tok', repos: ['o/r'], expires_at: 'not-a-date' } },
    });
    expect(() => parseTokensFile(json)).toThrow(FatalError);
    expect(() => parseTokensFile(json)).toThrow(/expires_at/);
  });

  it('throws FatalError for non-string expires_at', () => {
    const json = JSON.stringify({
      projects: { proj: { token: 'tok', repos: ['o/r'], expires_at: 12345 } },
    });
    expect(() => parseTokensFile(json)).toThrow(FatalError);
  });

  it('throws FatalError for duplicate repos across projects', () => {
    const json = JSON.stringify({
      projects: {
        proj1: { token: 'tok1', repos: ['owner/shared-repo'] },
        proj2: { token: 'tok2', repos: ['owner/shared-repo'] },
      },
    });
    expect(() => parseTokensFile(json)).toThrow(FatalError);
    expect(() => parseTokensFile(json)).toThrow(/owner\/shared-repo/);
    expect(() => parseTokensFile(json)).toThrow(/proj1/);
    expect(() => parseTokensFile(json)).toThrow(/proj2/);
  });

  it('parses a valid multi-project tokens file correctly', () => {
    const json = JSON.stringify({
      projects: {
        'my-project': {
          token: 'github_pat_abc123',
          repos: ['owner/repo-a', 'owner/repo-b'],
          expires_at: '2026-08-15T00:00:00.000Z',
        },
        'other-project': {
          token: 'github_pat_xyz789',
          repos: ['org/repo-c'],
        },
      },
    });
    const map = parseTokensFile(json);
    expect(map.projects.size).toBe(2);
    expect(map.repoIndex.size).toBe(3);

    const myProj = map.projects.get('my-project');
    expect(myProj).toBeDefined();
    expect(myProj!.token.reveal()).toBe('github_pat_abc123');
    expect([...myProj!.repos]).toEqual(['owner/repo-a', 'owner/repo-b']);
    expect(myProj!.expiresAt).toEqual(new Date('2026-08-15T00:00:00.000Z'));

    const otherProj = map.projects.get('other-project');
    expect(otherProj).toBeDefined();
    expect(otherProj!.token.reveal()).toBe('github_pat_xyz789');
    expect([...otherProj!.repos]).toEqual(['org/repo-c']);
    expect(otherProj!.expiresAt).toBeUndefined();

    // Repo index
    expect(map.repoIndex.get('owner/repo-a')).toBe('my-project');
    expect(map.repoIndex.get('owner/repo-b')).toBe('my-project');
    expect(map.repoIndex.get('org/repo-c')).toBe('other-project');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: validateProjectEntry edge cases
// ---------------------------------------------------------------------------
describe('validateProjectEntry — edge cases', () => {
  it('throws when entry is null', () => {
    expect(() => validateProjectEntry('proj', null)).toThrow(FatalError);
  });

  it('throws when entry is a string', () => {
    expect(() => validateProjectEntry('proj', 'not-an-object')).toThrow(FatalError);
  });

  it('throws when entry is a number', () => {
    expect(() => validateProjectEntry('proj', 42)).toThrow(FatalError);
  });

  it('accepts valid entry with optional expires_at', () => {
    const entry = { token: 'tok', repos: ['o/r'], expires_at: '2026-12-01T00:00:00Z' };
    const result = validateProjectEntry('proj', entry);
    expect(result.expiresAt).toEqual(new Date('2026-12-01T00:00:00Z'));
  });

  it('accepts valid entry without expires_at', () => {
    const entry = { token: 'tok', repos: ['o/r'] };
    const result = validateProjectEntry('proj', entry);
    expect(result.expiresAt).toBeUndefined();
  });
});
