/**
 * ROADMAP.md intake adapter (task-attempt-outcome, tasks 12.1–12.2).
 *
 * ROADMAP.md is treated as ONE intake adapter over `TaskService.submitTask()`,
 * not as the primary work mechanism — the database is the source of truth and
 * the roadmap is an optional rendering of task state (Requirement 14.1/14.6).
 *
 * The importer scans the roadmap's checklist lines, writes a stable
 * `<!-- ar:<ULID> -->` annotation back to each unannotated item, and derives
 * the task's `external_id` from that annotation id so re-scans are idempotent
 * (Requirement 14.2/14.7). Correctness against concurrent importers comes from
 * a strict **push-before-submit** ordering (Requirement 14.3 / 20.7 / 20.8):
 *
 *   (a) `git pull --ff-only` the roadmap branch so the scan sees the latest
 *       committed annotations;
 *   (b) for each unannotated item, generate a ULID, write the annotation back,
 *       and commit it;
 *   (c) push the annotation commit;
 *   (d) only on a successful push, call `submitTask()` using the pushed
 *       annotation id as `external_id`.
 *
 * On a non-fast-forward rejection (another writer advanced the branch) the
 * importer discards the local commit, re-pulls, and restarts the scan so the
 * loser adopts the winner's annotation rather than minting a competing ULID.
 * On a protected default branch (push rejected with a permission error) the
 * importer skips the write-back and derives `external_id` from a content hash
 * of the item instead, so idempotency still holds without writing to the repo.
 *
 * A ROADMAP item's checkbox is ticked (and the tick committed + pushed) ONLY
 * when its task reaches state `succeeded` — never when an attempt merely starts
 * (Requirement 14.5 / 20.5).
 *
 * The pure parse/annotate/tick functions are exported individually for Tier 1
 * testing; `RoadmapImporter` composes them with an injectable `GitRunner` and
 * `TaskService` (DI over singletons).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './log.js';
import type { TaskService } from './task-service.js';
import type { TaskDatabase } from './task-db.js';
import { ulid } from './ulid.js';

// ---------------------------------------------------------------------------
// Pure parse / annotate / tick functions (task 12.1)
// ---------------------------------------------------------------------------

/** A single ROADMAP checklist item (Requirement 20.3/20.4). */
export interface RoadmapItem {
  /** 0-based line number of the checklist line within the markdown. */
  lineNo: number;
  /** The checklist item text with the annotation comment stripped (Req 20.3). */
  text: string;
  /** Whether the checkbox is already ticked (`- [x]`). */
  checked: boolean;
  /** The `<!-- ar:<ULID> -->` annotation id when present (Requirement 14.2). */
  annotationId?: string;
}

/** Matches a checklist line (`- [ ]`/`- [x]`/`* [ ]`), capturing the body. */
const CHECKBOX_LINE_RE = /^(\s*[-*]\s+\[)([ xX])(\]\s?)(.*)$/;
/** Matches a trailing `<!-- ar:<ULID> -->` annotation, capturing the id. */
const ANNOTATION_RE = /\s*<!--\s*ar:([0-9A-HJKMNP-TV-Z]{26})\s*-->\s*$/;

/**
 * Parse a ROADMAP markdown document into its checklist items. Lines that are
 * not checklist lines are ignored (so headers and prose are skipped), matching
 * the existing `src/roadmap.ts` behavior but additionally extracting the
 * `<!-- ar:<ULID> -->` annotation and reporting it as `annotationId`.
 */
export function parseRoadmapItems(markdown: string): RoadmapItem[] {
  if (markdown === '') return [];
  const lines = markdown.split('\n');
  const items: RoadmapItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const match = CHECKBOX_LINE_RE.exec(line);
    if (match === null) continue;
    const checked = match[2] !== ' ';
    const body = match[4] as string;
    const annMatch = ANNOTATION_RE.exec(body);
    const annotationId = annMatch !== null ? (annMatch[1] as string) : undefined;
    const text = annotationId !== undefined ? body.replace(ANNOTATION_RE, '').trimEnd() : body.trimEnd();
    const item: RoadmapItem = { lineNo: i, text: text.trim(), checked };
    if (annotationId !== undefined) item.annotationId = annotationId;
    items.push(item);
  }
  return items;
}

/**
 * Append a `<!-- ar:<ULID> -->` annotation to a checklist line (Requirement
 * 14.3). The id is appended once, after any existing trailing whitespace is
 * trimmed; a line that already carries an annotation is returned unchanged so
 * annotation is idempotent (re-annotation stability).
 */
export function annotateLine(line: string, id: string): string {
  if (ANNOTATION_RE.test(line)) return line;
  return `${line.replace(/\s+$/, '')} <!-- ar:${id} -->`;
}

/**
 * Tick an unchecked checklist line (`- [ ]` → `- [x]`), preserving the bullet
 * marker, indentation, body, and any annotation (Requirement 14.5). A line that
 * is not an unchecked checklist line is returned unchanged.
 */
export function tickCheckbox(line: string): string {
  const match = CHECKBOX_LINE_RE.exec(line);
  if (match === null || match[2] !== ' ') return line;
  return `${match[1]}x${match[3]}${match[4]}`;
}

// ---------------------------------------------------------------------------
// Git runner (injectable, task 12.2)
// ---------------------------------------------------------------------------

/** The outcome of an annotation push (Requirement 20.8). */
export type PushResult = 'ok' | 'non_fast_forward' | 'protected';

/**
 * The git surface the importer needs, injectable so Tier 1/2 tests can drive it
 * against a local repo (or a fake) without network access. The default
 * implementation shells out via `execFileSync`, mirroring `worktree-manager.ts`.
 */
export interface GitRunner {
  /** `git pull --ff-only` the roadmap branch so the scan sees latest annotations. */
  pullFfOnly(): void;
  /** Read `ROADMAP.md` from the repo's default branch (Requirement 20.2). */
  readRoadmap(filePath: string): string;
  /** Write the file, `git commit`, and `git push`; report the push outcome. */
  commitAndPush(filePath: string, contents: string, message: string): PushResult;
  /** Discard the most recent local commit (`git reset --hard HEAD~1`). */
  discardLastCommit(): void;
}

export interface ExecGitRunnerDeps {
  /** The working directory of a checked-out clone of the roadmap repo. */
  cwd: string;
  /** The branch to pull/push (the repo's default branch). */
  branch: string;
  log: Logger;
  /** Override the git executable for testing. Defaults to `git`. */
  gitBin?: string;
}

/** Classify a `git push` failure stderr into a closed {@link PushResult}. */
export function classifyPushError(stderr: string): PushResult {
  const lower = stderr.toLowerCase();
  if (
    lower.includes('protected branch') ||
    lower.includes('permission to') ||
    lower.includes('403') ||
    lower.includes('pre-receive hook declined') ||
    lower.includes('denied')
  ) {
    return 'protected';
  }
  // Non-fast-forward: another writer advanced the branch.
  return 'non_fast_forward';
}

/** The default {@link GitRunner} that shells out to the `git` CLI. */
export function createExecGitRunner(deps: ExecGitRunnerDeps): GitRunner {
  const { cwd, branch, log } = deps;
  const git = deps.gitBin ?? 'git';
  const run = (args: string[]): string =>
    execFileSync(git, args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

  return {
    pullFfOnly(): void {
      run(['pull', '--ff-only', 'origin', branch]);
    },
    readRoadmap(filePath: string): string {
      // Read from the current branch tip (HEAD). After `pull --ff-only` this is
      // the latest committed default-branch tree; after a local annotation
      // commit it reflects that annotation too.
      return run(['show', `HEAD:${filePath}`]);
    },
    commitAndPush(filePath: string, contents: string, message: string): PushResult {
      writeFileSync(join(cwd, filePath), contents, 'utf-8');
      run(['add', filePath]);
      run(['commit', '-m', message]);
      try {
        run(['push', 'origin', `HEAD:${branch}`]);
        return 'ok';
      } catch (err: unknown) {
        const stderr =
          typeof err === 'object' && err !== null && 'stderr' in err
            ? String((err as { stderr: unknown }).stderr)
            : err instanceof Error
              ? err.message
              : String(err);
        const result = classifyPushError(stderr);
        log.warn('Roadmap annotation push rejected', { branch, result, stderr });
        return result;
      }
    },
    discardLastCommit(): void {
      run(['reset', '--hard', 'HEAD~1']);
    },
  };
}

// ---------------------------------------------------------------------------
// RoadmapImporter (task 12.2)
// ---------------------------------------------------------------------------

export interface RoadmapImporterDeps {
  taskService: TaskService;
  db: TaskDatabase;
  git: GitRunner;
  /** `owner/name` of the repo this importer scans. */
  repo: string;
  /** Path to the roadmap file within the repo (default `ROADMAP.md`). */
  roadmapPath?: string;
  log: Logger;
  /** Override the ULID generator for deterministic tests. */
  newId?: () => string;
  /** Max scan restarts after a non-fast-forward rejection (default 10). */
  maxScanRestarts?: number;
}

/**
 * Derive a stable `external_id` content hash from an item's text, used when the
 * default branch is protected and the annotation cannot be written back
 * (Requirement 20.8). Prefixed `sha256:` to distinguish it from a ULID.
 */
export function contentHashExternalId(repo: string, text: string): string {
  const hash = createHash('sha256').update(`${repo}\n${text}`).digest('hex');
  return `sha256:${hash}`;
}

export class RoadmapImporter {
  private readonly taskService: TaskService;
  private readonly db: TaskDatabase;
  private readonly git: GitRunner;
  private readonly repo: string;
  private readonly roadmapPath: string;
  private readonly log: Logger;
  private readonly newId: () => string;
  private readonly maxScanRestarts: number;

  constructor(deps: RoadmapImporterDeps) {
    this.taskService = deps.taskService;
    this.db = deps.db;
    this.git = deps.git;
    this.repo = deps.repo;
    this.roadmapPath = deps.roadmapPath ?? 'ROADMAP.md';
    this.log = deps.log;
    this.newId = deps.newId ?? (() => ulid());
    this.maxScanRestarts = deps.maxScanRestarts ?? 10;
  }

  /**
   * Run one scan cycle (Requirement 20.1 — driven by a cron tick). Pulls the
   * roadmap branch, scans each checklist item, writes-back-and-submits any
   * unannotated item (push-before-submit, Requirement 20.8), and ticks the
   * checkboxes of items whose tasks have reached `succeeded` (Requirement 20.5).
   */
  scan(): void {
    for (let restart = 0; restart <= this.maxScanRestarts; restart++) {
      this.git.pullFfOnly();
      let markdown = this.git.readRoadmap(this.roadmapPath);
      const items = parseRoadmapItems(markdown);

      let restartNeeded = false;
      for (const item of items) {
        // Skip already-ticked items entirely (Requirement 20.6).
        if (item.checked) continue;

        if (item.annotationId === undefined) {
          const outcome = this.writeBackAndSubmit(markdown, item);
          if (outcome === 'restart') {
            restartNeeded = true;
            break; // re-pull and restart the scan from the beginning
          }
          // The markdown on disk advanced (annotation written); re-read so the
          // remaining items keep correct line numbers.
          markdown = this.git.readRoadmap(this.roadmapPath);
        } else {
          // Already annotated: submit idempotently (no-op if the task exists).
          this.submitForAnnotation(item.annotationId, item);
        }
      }

      if (!restartNeeded) {
        this.tickSucceeded(markdown);
        return;
      }
    }
    this.log.warn('Roadmap scan exceeded max restarts; giving up this cycle', {
      repo: this.repo,
      maxScanRestarts: this.maxScanRestarts,
    });
  }

  /**
   * Write back an annotation for an unannotated item, push it, and only on a
   * successful push submit the task (Requirement 20.8). Returns `'restart'`
   * when a non-fast-forward rejection means the scan must restart.
   */
  private writeBackAndSubmit(markdown: string, item: RoadmapItem): 'done' | 'restart' {
    const id = this.newId();
    const lines = markdown.split('\n');
    lines[item.lineNo] = annotateLine(lines[item.lineNo] as string, id);
    const next = lines.join('\n');

    const push = this.git.commitAndPush(
      this.roadmapPath,
      next,
      `chore(roadmap): annotate item ${id}`
    );

    if (push === 'ok') {
      this.submitForAnnotation(id, item);
      return 'done';
    }
    if (push === 'non_fast_forward') {
      // Another writer advanced the branch: discard, re-pull, restart the scan.
      this.git.discardLastCommit();
      return 'restart';
    }
    // Protected branch: skip write-back, derive external_id from a content hash.
    const externalId = contentHashExternalId(this.repo, item.text);
    this.git.discardLastCommit();
    this.submitForExternalId(externalId, item);
    return 'done';
  }

  /** Submit a task keyed on the pushed annotation id (Requirement 14.2/14.4). */
  private submitForAnnotation(annotationId: string, item: RoadmapItem): void {
    this.submitForExternalId(annotationId, item);
  }

  /** Submit a task keyed on `externalId`, idempotent on re-scan (Req 14.7). */
  private submitForExternalId(externalId: string, item: RoadmapItem): void {
    const result = this.taskService.submitTask({
      externalId,
      repo: this.repo,
      source: 'roadmap',
      sourceRef: `${this.roadmapPath}#${externalId}`,
      title: item.text,
      spec: item.text,
      baseRef: null,
      agent: 'kiro',
      budget: null,
      metadata: null,
    });
    if (result.created) {
      this.log.info('Roadmap item imported as task', {
        repo: this.repo,
        externalId,
        taskId: result.task.id,
      });
    }
  }

  /**
   * Tick the checkbox of every annotated item whose task has reached
   * `succeeded`, committing and pushing the change (Requirement 14.5 / 20.5).
   * Items whose tasks are not yet succeeded are left unchanged.
   */
  private tickSucceeded(markdown: string): void {
    const items = parseRoadmapItems(markdown);
    const lines = markdown.split('\n');
    let changed = false;

    for (const item of items) {
      if (item.checked || item.annotationId === undefined) continue;
      const task = this.db.getTaskByExternalId(item.annotationId);
      if (task === null || task.state !== 'succeeded') continue;
      const ticked = tickCheckbox(lines[item.lineNo] as string);
      if (ticked !== lines[item.lineNo]) {
        lines[item.lineNo] = ticked;
        changed = true;
      }
    }

    if (!changed) return;
    const next = lines.join('\n');
    const push = this.git.commitAndPush(
      this.roadmapPath,
      next,
      'chore(roadmap): tick completed items'
    );
    if (push !== 'ok') {
      // Best-effort: a rejected tick is retried on the next scan cycle.
      this.git.discardLastCommit();
      this.log.warn('Roadmap checkbox tick push rejected; will retry next cycle', {
        repo: this.repo,
        result: push,
      });
    }
  }
}
