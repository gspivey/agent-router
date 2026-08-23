/**
 * Pure logic module for the "project" concept — a named group of repos
 * with computed health and token coverage.
 *
 * All functions are pure (no I/O) and exported individually for testability.
 */

export interface ProjectConfig {
  name: string;
  repos: string[];
}

export type ProjectHealthStatus = 'green' | 'partial' | 'paused';

export interface ComputedProjectHealth {
  status: ProjectHealthStatus;
  activeSessions: number;
  failedSessions: number;
}

export interface TokenCoverage {
  complete: boolean;
  missingRepos: string[];
}

export interface RepoSessionCounts {
  active: number;
  failed: number;
  lastSessionAt: Date | null;
}

/**
 * Compute aggregate health for a project given per-repo session counts.
 *
 * Health states:
 * - green: no failed/abandoned sessions across project repos
 * - partial: at least one repo has failed/abandoned, others healthy
 * - paused: zero active sessions AND no session within last 24h (or never)
 */
export function computeProjectHealth(
  repoSessionCounts: Map<string, RepoSessionCounts>,
  projectRepos: string[],
  now: Date = new Date(),
): ComputedProjectHealth {
  let totalActive = 0;
  let totalFailed = 0;
  let hasRecentSession = false;

  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  for (const repo of projectRepos) {
    const counts = repoSessionCounts.get(repo);
    if (counts === undefined) {
      // Repo with no session history — contributes nothing
      continue;
    }
    totalActive += counts.active;
    totalFailed += counts.failed;
    if (counts.lastSessionAt !== null && counts.lastSessionAt > twentyFourHoursAgo) {
      hasRecentSession = true;
    }
  }

  let status: ProjectHealthStatus;
  if (totalFailed > 0) {
    status = 'partial';
  } else if (totalActive === 0 && !hasRecentSession) {
    status = 'paused';
  } else {
    status = 'green';
  }

  return { status, activeSessions: totalActive, failedSessions: totalFailed };
}

/**
 * Check token coverage for a project.
 * A repo is covered if it has a per-repo token OR defaultGithubToken is set.
 */
export function computeTokenCoverage(
  projectRepos: string[],
  repoConfigs: Array<{ fullName: string; hasToken: boolean }>,
  hasDefaultToken: boolean,
): TokenCoverage {
  if (hasDefaultToken) {
    return { complete: true, missingRepos: [] };
  }

  const configMap = new Map(repoConfigs.map(r => [r.fullName, r.hasToken]));
  const missingRepos: string[] = [];

  for (const repo of projectRepos) {
    const hasToken = configMap.get(repo);
    if (hasToken !== true) {
      missingRepos.push(repo);
    }
  }

  return { complete: missingRepos.length === 0, missingRepos };
}

/**
 * Partition all configured repos into project-assigned and ungrouped.
 */
export function partitionRepos(
  allRepos: string[],
  projects: ProjectConfig[],
): { assigned: Set<string>; ungrouped: string[] } {
  const assigned = new Set<string>();
  for (const project of projects) {
    for (const repo of project.repos) {
      assigned.add(repo);
    }
  }

  const ungrouped = allRepos.filter(r => !assigned.has(r));
  return { assigned, ungrouped };
}

/**
 * Validate project config: unique names, no duplicate repo assignments,
 * repos reference known configured repos.
 */
export function validateProjects(
  projects: ProjectConfig[],
  knownRepos: string[],
): { valid: true } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  const knownSet = new Set(knownRepos);

  // Check for duplicate project names (case-insensitive)
  const seenNames = new Map<string, string>();
  for (const project of projects) {
    if (typeof project.name !== 'string' || project.name.length === 0) {
      errors.push('Each project must have a non-empty "name"');
      continue;
    }
    if (!Array.isArray(project.repos) || project.repos.length === 0) {
      errors.push(`Project "${project.name}" must have a non-empty "repos" array`);
      continue;
    }
    const lower = project.name.toLowerCase();
    const existing = seenNames.get(lower);
    if (existing !== undefined) {
      errors.push(`Duplicate project name: "${project.name}" conflicts with "${existing}" (case-insensitive)`);
    } else {
      seenNames.set(lower, project.name);
    }
  }

  // Check for unknown repos and cross-project duplicates
  const seenRepos = new Map<string, string>();
  for (const project of projects) {
    if (!Array.isArray(project.repos)) continue;
    for (const repo of project.repos) {
      if (typeof repo !== 'string') {
        errors.push(`Project "${project.name}" contains a non-string repo entry`);
        continue;
      }
      if (!knownSet.has(repo)) {
        errors.push(`Project "${project.name}" references unknown repo "${repo}" (not in configured repos)`);
      }
      const assignedTo = seenRepos.get(repo);
      if (assignedTo !== undefined) {
        errors.push(`Repo "${repo}" appears in multiple projects: "${assignedTo}" and "${project.name}"`);
      } else {
        seenRepos.set(repo, project.name);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}
