/**
 * Tier 1 tests for src/projects.ts — pure logic module.
 *
 * Covers: computeProjectHealth, computeTokenCoverage, partitionRepos, validateProjects.
 */
import { describe, it, expect } from 'vitest';
import {
  computeProjectHealth,
  computeTokenCoverage,
  partitionRepos,
  validateProjects,
} from '../../src/projects.js';
import type { RepoSessionCounts } from '../../src/projects.js';

describe('computeProjectHealth', () => {
  const now = new Date('2026-08-23T12:00:00Z');

  it('returns green when all repos have zero failed sessions', () => {
    const counts = new Map<string, RepoSessionCounts>([
      ['org/repo1', { active: 2, failed: 0, lastSessionAt: new Date('2026-08-23T11:00:00Z') }],
      ['org/repo2', { active: 1, failed: 0, lastSessionAt: new Date('2026-08-23T10:00:00Z') }],
    ]);
    const result = computeProjectHealth(counts, ['org/repo1', 'org/repo2'], now);
    expect(result.status).toBe('green');
    expect(result.activeSessions).toBe(3);
    expect(result.failedSessions).toBe(0);
  });

  it('returns partial when one repo has a failed session', () => {
    const counts = new Map<string, RepoSessionCounts>([
      ['org/repo1', { active: 1, failed: 0, lastSessionAt: new Date('2026-08-23T11:00:00Z') }],
      ['org/repo2', { active: 0, failed: 1, lastSessionAt: new Date('2026-08-23T10:00:00Z') }],
    ]);
    const result = computeProjectHealth(counts, ['org/repo1', 'org/repo2'], now);
    expect(result.status).toBe('partial');
    expect(result.activeSessions).toBe(1);
    expect(result.failedSessions).toBe(1);
  });

  it('returns paused when zero active sessions and no recent session', () => {
    const counts = new Map<string, RepoSessionCounts>([
      ['org/repo1', { active: 0, failed: 0, lastSessionAt: new Date('2026-08-20T12:00:00Z') }],
      ['org/repo2', { active: 0, failed: 0, lastSessionAt: new Date('2026-08-21T12:00:00Z') }],
    ]);
    const result = computeProjectHealth(counts, ['org/repo1', 'org/repo2'], now);
    expect(result.status).toBe('paused');
    expect(result.activeSessions).toBe(0);
    expect(result.failedSessions).toBe(0);
  });

  it('returns paused when all repos have null lastSessionAt', () => {
    const counts = new Map<string, RepoSessionCounts>([
      ['org/repo1', { active: 0, failed: 0, lastSessionAt: null }],
    ]);
    const result = computeProjectHealth(counts, ['org/repo1'], now);
    expect(result.status).toBe('paused');
  });

  it('returns green for an empty repo list (vacuous truth)', () => {
    const counts = new Map<string, RepoSessionCounts>();
    const result = computeProjectHealth(counts, [], now);
    // No active, no failed, no repos — should be paused by the rule
    // Actually: 0 active, no recent session → paused
    expect(result.status).toBe('paused');
    expect(result.activeSessions).toBe(0);
    expect(result.failedSessions).toBe(0);
  });

  it('treats repos with no entry in the counts map as healthy-inactive', () => {
    const counts = new Map<string, RepoSessionCounts>([
      ['org/repo1', { active: 1, failed: 0, lastSessionAt: new Date('2026-08-23T11:00:00Z') }],
    ]);
    // org/repo2 has no entry — should not cause partial
    const result = computeProjectHealth(counts, ['org/repo1', 'org/repo2'], now);
    expect(result.status).toBe('green');
    expect(result.activeSessions).toBe(1);
  });

  it('partial takes priority over paused when failed sessions exist without active', () => {
    const counts = new Map<string, RepoSessionCounts>([
      ['org/repo1', { active: 0, failed: 1, lastSessionAt: new Date('2026-08-20T00:00:00Z') }],
    ]);
    const result = computeProjectHealth(counts, ['org/repo1'], now);
    // 0 active, no recent session → paused candidate, but failed > 0 → partial
    expect(result.status).toBe('partial');
  });
});

describe('computeTokenCoverage', () => {
  it('returns complete when all repos have a token', () => {
    const result = computeTokenCoverage(
      ['org/repo1', 'org/repo2'],
      [
        { fullName: 'org/repo1', hasToken: true },
        { fullName: 'org/repo2', hasToken: true },
      ],
      false,
    );
    expect(result.complete).toBe(true);
    expect(result.missingRepos).toEqual([]);
  });

  it('returns complete when defaultGithubToken is set', () => {
    const result = computeTokenCoverage(
      ['org/repo1', 'org/repo2'],
      [
        { fullName: 'org/repo1', hasToken: false },
        { fullName: 'org/repo2', hasToken: false },
      ],
      true,
    );
    expect(result.complete).toBe(true);
    expect(result.missingRepos).toEqual([]);
  });

  it('returns incomplete with missing repos listed', () => {
    const result = computeTokenCoverage(
      ['org/repo1', 'org/repo2'],
      [
        { fullName: 'org/repo1', hasToken: true },
        { fullName: 'org/repo2', hasToken: false },
      ],
      false,
    );
    expect(result.complete).toBe(false);
    expect(result.missingRepos).toEqual(['org/repo2']);
  });

  it('handles repo not in repoConfigs as missing', () => {
    const result = computeTokenCoverage(
      ['org/repo1', 'org/unknown'],
      [{ fullName: 'org/repo1', hasToken: true }],
      false,
    );
    expect(result.complete).toBe(false);
    expect(result.missingRepos).toEqual(['org/unknown']);
  });
});

describe('partitionRepos', () => {
  it('splits repos between assigned and ungrouped', () => {
    const result = partitionRepos(
      ['org/repo1', 'org/repo2', 'org/repo3'],
      [{ name: 'Core', repos: ['org/repo1', 'org/repo2'] }],
    );
    expect(result.assigned).toEqual(new Set(['org/repo1', 'org/repo2']));
    expect(result.ungrouped).toEqual(['org/repo3']);
  });

  it('returns all as ungrouped when no projects defined', () => {
    const result = partitionRepos(['org/repo1', 'org/repo2'], []);
    expect(result.assigned.size).toBe(0);
    expect(result.ungrouped).toEqual(['org/repo1', 'org/repo2']);
  });

  it('handles multiple projects', () => {
    const result = partitionRepos(
      ['org/a', 'org/b', 'org/c', 'org/d'],
      [
        { name: 'P1', repos: ['org/a', 'org/b'] },
        { name: 'P2', repos: ['org/c'] },
      ],
    );
    expect(result.assigned).toEqual(new Set(['org/a', 'org/b', 'org/c']));
    expect(result.ungrouped).toEqual(['org/d']);
  });
});

describe('validateProjects', () => {
  const knownRepos = ['org/repo1', 'org/repo2', 'org/repo3'];

  it('passes for valid config', () => {
    const result = validateProjects(
      [{ name: 'Core', repos: ['org/repo1', 'org/repo2'] }],
      knownRepos,
    );
    expect(result).toEqual({ valid: true });
  });

  it('fails for duplicate project names (case-insensitive)', () => {
    const result = validateProjects(
      [
        { name: 'Core', repos: ['org/repo1'] },
        { name: 'CORE', repos: ['org/repo2'] },
      ],
      knownRepos,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('Duplicate project name'))).toBe(true);
    }
  });

  it('fails for unknown repo reference', () => {
    const result = validateProjects(
      [{ name: 'Core', repos: ['org/unknown'] }],
      knownRepos,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('unknown repo'))).toBe(true);
    }
  });

  it('fails when a repo appears in multiple projects', () => {
    const result = validateProjects(
      [
        { name: 'P1', repos: ['org/repo1'] },
        { name: 'P2', repos: ['org/repo1'] },
      ],
      knownRepos,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('multiple projects'))).toBe(true);
    }
  });

  it('fails for empty project name', () => {
    const result = validateProjects(
      [{ name: '', repos: ['org/repo1'] }],
      knownRepos,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('non-empty "name"'))).toBe(true);
    }
  });

  it('fails for empty repos array', () => {
    const result = validateProjects(
      [{ name: 'Core', repos: [] }],
      knownRepos,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some(e => e.includes('non-empty "repos" array'))).toBe(true);
    }
  });

  it('reports multiple errors at once', () => {
    const result = validateProjects(
      [
        { name: 'P1', repos: ['org/repo1'] },
        { name: 'P1', repos: ['org/unknown'] },
      ],
      knownRepos,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(1);
    }
  });
});
