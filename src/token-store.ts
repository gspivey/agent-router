/**
 * Token Store — project-scoped PAT credential management.
 *
 * This module defines the interfaces and pure validation functions for the Token_Store.
 * The factory function (`createTokenStore`) and lifecycle methods are implemented separately
 * (item 34) and depend on these pure functions.
 *
 * Pure functions exported here are tested directly via fast-check property tests and
 * unit tests (Tier 1). No I/O, no side effects.
 */

import { Secret } from './secret.js';
import { FatalError } from './errors.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Parsed and validated representation of a single project entry. */
export interface ProjectEntry {
  readonly name: string;
  readonly token: Secret;
  readonly repos: readonly string[];
  readonly expiresAt: Date | undefined;
}

/** The immutable snapshot of all project-token mappings. */
export interface TokenMap {
  readonly projects: ReadonlyMap<string, ProjectEntry>;
  readonly repoIndex: ReadonlyMap<string, string>; // repo → project name
}

/** Result of comparing two TokenMaps after a reload. */
export interface ReloadDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
}

/** A single expiry warning produced by evaluateExpiryWarnings. */
export interface ExpiryWarning {
  readonly projectName: string;
  readonly expiresAt: Date;
  readonly daysUntilExpiry: number;
  readonly level: 'warn' | 'error';
  readonly alert: boolean; // true for ≤7 days (maps "alert" tier to warn+alert)
  readonly message: string;
}

/** Token_Store interface — injected as a dependency into session manager, webhook handler, etc. */
export interface TokenStore {
  /** Get the PAT for a project by name. Returns undefined if not found. */
  getToken(projectName: string): Secret | undefined;

  /** Get the full ProjectEntry for a project. */
  getProject(projectName: string): ProjectEntry | undefined;

  /** Reverse lookup: find the project name that contains a given repo. */
  findProjectByRepo(repo: string): string | undefined;

  /** Get the current TokenMap snapshot (for CLI status, health checks). */
  getTokenMap(): TokenMap;

  /** Trigger a reload from disk. Returns true if the map was replaced. */
  reload(): boolean;

  /** Register fs.watch + polling fallback. Call once at startup. */
  startWatching(): void;

  /** Stop fs.watch and polling. Call on shutdown. */
  stopWatching(): void;
}

// ---------------------------------------------------------------------------
// Validation patterns
// ---------------------------------------------------------------------------

/** Pattern for valid project names: non-empty ASCII, alphanumeric + dot/underscore/dash */
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Pattern for valid repo strings: owner/repo with same character set */
const REPO_STRING_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

// ---------------------------------------------------------------------------
// Pure validation functions
// ---------------------------------------------------------------------------

/**
 * Validate a project name against the allowed pattern.
 * Returns true if the name is non-empty and matches ^[a-zA-Z0-9._-]+$.
 */
export function isValidProjectName(name: string): boolean {
  return PROJECT_NAME_PATTERN.test(name);
}

/**
 * Validate a repo string against the owner/repo pattern.
 * Returns true if the string matches ^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$.
 */
export function isValidRepoString(repo: string): boolean {
  return REPO_STRING_PATTERN.test(repo);
}

/**
 * Validate and parse a single project entry from raw JSON input.
 * Wraps the token in a Secret. Throws FatalError on invalid input.
 */
export function validateProjectEntry(name: string, entry: unknown): ProjectEntry {
  if (!isValidProjectName(name)) {
    throw new FatalError(
      `Invalid project name "${name}": must be non-empty ASCII matching ^[a-zA-Z0-9._-]+$`
    );
  }

  if (entry === null || typeof entry !== 'object') {
    throw new FatalError(`Project "${name}": entry must be an object`);
  }

  const obj = entry as Record<string, unknown>;

  // Validate token field
  if (typeof obj['token'] !== 'string' || obj['token'] === '') {
    throw new FatalError(`Project "${name}": "token" must be a non-empty string`);
  }

  // Validate repos field
  if (!Array.isArray(obj['repos']) || obj['repos'].length === 0) {
    throw new FatalError(`Project "${name}": "repos" must be a non-empty array`);
  }

  const repos: string[] = [];
  for (const repo of obj['repos']) {
    if (typeof repo !== 'string' || !isValidRepoString(repo)) {
      throw new FatalError(
        `Project "${name}": invalid repo "${String(repo)}" — must match ^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$`
      );
    }
    repos.push(repo);
  }

  // Validate optional expires_at field
  let expiresAt: Date | undefined;
  if (obj['expires_at'] !== undefined) {
    if (typeof obj['expires_at'] !== 'string') {
      throw new FatalError(
        `Project "${name}": "expires_at" must be a string (ISO 8601 date-time)`
      );
    }
    const parsed = new Date(obj['expires_at']);
    if (isNaN(parsed.getTime())) {
      throw new FatalError(
        `Project "${name}": "expires_at" is not a valid ISO 8601 date-time: "${obj['expires_at']}"`
      );
    }
    expiresAt = parsed;
  }

  return {
    name,
    token: Secret.of(obj['token']),
    repos,
    expiresAt,
  };
}

/**
 * Validate the repo-uniqueness invariant across all projects.
 * Throws FatalError if any repo appears in more than one project.
 */
export function validateRepoUniqueness(projects: ReadonlyMap<string, ProjectEntry>): void {
  const seen = new Map<string, string>(); // repo → first project name
  for (const [projectName, entry] of projects) {
    for (const repo of entry.repos) {
      const existingProject = seen.get(repo);
      if (existingProject !== undefined) {
        throw new FatalError(
          `Duplicate repo "${repo}" found in projects "${existingProject}" and "${projectName}"`
        );
      }
      seen.set(repo, projectName);
    }
  }
}

/**
 * Parse and validate tokens.json content into a TokenMap.
 * Throws FatalError on invalid JSON, missing fields, schema violations, or duplicate repos.
 */
export function parseTokensFile(content: string): TokenMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new FatalError(
      `tokens.json contains invalid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new FatalError('tokens.json must be a JSON object');
  }

  const root = parsed as Record<string, unknown>;

  if (root['projects'] === undefined || root['projects'] === null || typeof root['projects'] !== 'object') {
    throw new FatalError('tokens.json must contain a "projects" object');
  }

  if (Array.isArray(root['projects'])) {
    throw new FatalError('tokens.json "projects" must be an object, not an array');
  }

  const projectsRaw = root['projects'] as Record<string, unknown>;
  const projects = new Map<string, ProjectEntry>();

  for (const [name, entry] of Object.entries(projectsRaw)) {
    projects.set(name, validateProjectEntry(name, entry));
  }

  // Validate cross-project repo uniqueness
  validateRepoUniqueness(projects);

  // Build repo index
  const repoIndex = new Map<string, string>();
  for (const [projectName, entry] of projects) {
    for (const repo of entry.repos) {
      repoIndex.set(repo, projectName);
    }
  }

  return { projects, repoIndex };
}

/**
 * Compute the diff between two TokenMaps.
 *
 * A project is "changed" if its token value or repos list differ between old and new.
 * Expiry date changes are also considered a change.
 */
export function computeReloadDiff(oldMap: TokenMap, newMap: TokenMap): ReloadDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  // Check projects in new map
  for (const [name, newEntry] of newMap.projects) {
    const oldEntry = oldMap.projects.get(name);
    if (oldEntry === undefined) {
      added.push(name);
    } else {
      const tokenChanged = oldEntry.token.reveal() !== newEntry.token.reveal();
      const reposChanged = !arraysEqual(oldEntry.repos, newEntry.repos);
      const expiryChanged = !datesEqual(oldEntry.expiresAt, newEntry.expiresAt);
      if (tokenChanged || reposChanged || expiryChanged) {
        changed.push(name);
      } else {
        unchanged.push(name);
      }
    }
  }

  // Check projects removed (in old but not in new)
  for (const name of oldMap.projects.keys()) {
    if (!newMap.projects.has(name)) {
      removed.push(name);
    }
  }

  return { added, removed, changed, unchanged };
}

/**
 * Evaluate expiry warnings for all projects that have an expires_at date.
 *
 * Tiering:
 *   - Expired (≤ 0 days): level 'error', alert false
 *   - ≤ 2 days: level 'error', alert false
 *   - ≤ 7 days: level 'warn', alert true
 *   - ≤ 14 days: level 'warn', alert false
 *   - > 14 days: no warning emitted
 */
export function evaluateExpiryWarnings(
  projects: ReadonlyMap<string, ProjectEntry>,
  now: Date
): ExpiryWarning[] {
  const warnings: ExpiryWarning[] = [];

  for (const [, entry] of projects) {
    if (entry.expiresAt === undefined) continue;

    const msUntilExpiry = entry.expiresAt.getTime() - now.getTime();
    const daysUntilExpiry = Math.ceil(msUntilExpiry / (24 * 60 * 60 * 1000));

    if (daysUntilExpiry > 14) continue;

    let level: 'warn' | 'error';
    let alert: boolean;
    let message: string;

    if (daysUntilExpiry <= 0) {
      level = 'error';
      alert = false;
      message = `Token for project "${entry.name}" has expired — still serving but may fail`;
    } else if (daysUntilExpiry <= 2) {
      level = 'error';
      alert = false;
      message = `Token for project "${entry.name}" expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'} — immediate rotation required`;
    } else if (daysUntilExpiry <= 7) {
      level = 'warn';
      alert = true;
      message = `Token for project "${entry.name}" expires in ${daysUntilExpiry} days — rotate soon`;
    } else {
      // 8–14 days
      level = 'warn';
      alert = false;
      message = `Token for project "${entry.name}" expires in ${daysUntilExpiry} days`;
    }

    warnings.push({
      projectName: entry.name,
      expiresAt: entry.expiresAt,
      daysUntilExpiry,
      level,
      alert,
      message,
    });
  }

  return warnings;
}

/**
 * Serialize a TokenMap back to the tokens.json schema format.
 * Used for round-trip property testing.
 */
export function serializeTokenMap(map: TokenMap): string {
  const projects: Record<string, { token: string; repos: string[]; expires_at?: string }> = {};

  for (const [name, entry] of map.projects) {
    const serialized: { token: string; repos: string[]; expires_at?: string } = {
      token: entry.token.reveal(),
      repos: [...entry.repos],
    };
    if (entry.expiresAt !== undefined) {
      serialized.expires_at = entry.expiresAt.toISOString();
    }
    projects[name] = serialized;
  }

  return JSON.stringify({ projects });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function datesEqual(a: Date | undefined, b: Date | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.getTime() === b.getTime();
}
