/**
 * Tier 2 tests: ROADMAP intake adapter against real local git repos + SQLite
 * (task-attempt-outcome, task 12.4).
 *
 * No network: a bare repo stands in for `origin`, with a working clone the
 * importer pulls/annotates/pushes against. Covers:
 *  - an unannotated item has its annotation committed + PUSHED before the task
 *    is submitted (push-before-submit ordering, Requirement 20.8);
 *  - a non-fast-forward rejection makes the importer discard, re-pull, and
 *    restart the scan (no competing task, no duplicate);
 *  - a protected-branch push rejection makes the importer skip write-back and
 *    derive `external_id` from a content hash;
 *  - `title`/`spec` derivation, `git pull --ff-only` before scanning;
 *  - re-scan creates no duplicate (idempotent on external_id);
 *  - already-`[x]` items are skipped;
 *  - the checkbox is ticked + pushed ONLY after the task reaches `succeeded`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initTaskDatabase } from '../../src/task-db.js';
import type { TaskDatabase } from '../../src/task-db.js';
import { TaskService } from '../../src/task-service.js';
import type { TaskScheduler } from '../../src/task-service.js';
import {
  RoadmapImporter,
  createExecGitRunner,
  parseRoadmapItems,
  type GitRunner,
  type PushResult,
} from '../../src/roadmap-importer.js';
import type { Logger } from '../../src/log.js';

const REPO = 'owner/repo';
const BRANCH = 'main';

const noopLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
};

const noopScheduler: TaskScheduler = { enqueue() {} };

let cleanupFns: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  cleanupFns = [];
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

interface Harness {
  dir: string;
  bare: string;
  clone: string;
  db: TaskDatabase;
  service: TaskService;
  git: GitRunner;
}

/** Build a bare "origin" + a working clone seeded with the given ROADMAP.md. */
function setup(roadmap: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-import-'));
  cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));

  const bare = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  const clone = join(dir, 'clone');

  git(dir, ['init', '--bare', '-b', BRANCH, bare]);

  // Seed the bare repo with an initial ROADMAP.md commit.
  git(dir, ['clone', bare, seed]);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'Test']);
  writeFileSync(join(seed, 'ROADMAP.md'), roadmap, 'utf-8');
  git(seed, ['add', 'ROADMAP.md']);
  git(seed, ['commit', '-m', 'seed roadmap']);
  git(seed, ['push', 'origin', BRANCH]);

  // The importer's working clone.
  git(dir, ['clone', bare, clone]);
  git(clone, ['config', 'user.email', 'importer@example.com']);
  git(clone, ['config', 'user.name', 'Importer']);

  const handle = new BetterSqlite3(join(dir, 'tasks.db'));
  handle.pragma('journal_mode = WAL');
  cleanupFns.push(() => handle.close());
  const db = initTaskDatabase(handle);
  const service = new TaskService({
    db,
    scheduler: noopScheduler,
    configuredRepos: new Set([REPO]),
  });
  const runner = createExecGitRunner({ cwd: clone, branch: BRANCH, log: noopLog });

  return { dir, bare, clone, db, service, git: runner };
}

/** Read the committed ROADMAP.md from the bare repo's default branch. */
function readRemoteRoadmap(bare: string, dir: string): string {
  const check = join(dir, `check-${Math.random().toString(36).slice(2)}`);
  git(dir, ['clone', '--quiet', bare, check]);
  const content = readFileSync(join(check, 'ROADMAP.md'), 'utf-8');
  rmSync(check, { recursive: true, force: true });
  return content;
}

describe('RoadmapImporter (Tier 2, real git)', () => {
  it('annotates + pushes before submitting, derives title/spec, idempotent on re-scan', () => {
    const h = setup('# Roadmap\n\n- [ ] Build the widget\n');
    let newIdCounter = 0;
    const ids = ['01HAAAAAAAAAAAAAAAAAAAAAA1', '01HAAAAAAAAAAAAAAAAAAAAAA2'];
    const importer = new RoadmapImporter({
      taskService: h.service,
      db: h.db,
      git: h.git,
      repo: REPO,
      log: noopLog,
      newId: () => ids[newIdCounter++] as string,
    });

    importer.scan();

    // The annotation was pushed to origin BEFORE submit — the remote shows it.
    const remote = readRemoteRoadmap(h.bare, h.dir);
    const items = parseRoadmapItems(remote);
    expect(items).toHaveLength(1);
    expect(items[0]!.annotationId).toBe(ids[0]);

    // The task exists keyed on the annotation id, with title/spec from the item.
    const task = h.db.getTaskByExternalId(ids[0] as string);
    expect(task).not.toBeNull();
    expect(task!.repo).toBe(REPO);
    expect(task!.source).toBe('roadmap');
    expect(task!.sourceRef).toBe(`ROADMAP.md#${ids[0]}`);
    expect(task!.title).toBe('Build the widget');
    expect(task!.spec).toBe('Build the widget');

    // Re-scan creates no duplicate (idempotent on external_id).
    importer.scan();
    const all = h.db.listTasks({ repo: REPO });
    expect(all).toHaveLength(1);
  });

  it('skips already-[x] items', () => {
    const h = setup('- [x] Already done <!-- ar:01HBBBBBBBBBBBBBBBBBBBBBB1 -->\n');
    const importer = new RoadmapImporter({
      taskService: h.service,
      db: h.db,
      git: h.git,
      repo: REPO,
      log: noopLog,
    });
    importer.scan();
    expect(h.db.listTasks({ repo: REPO })).toHaveLength(0);
  });

  it('ticks + pushes a completed item ONLY after its task reaches succeeded', () => {
    const annId = '01HCCCCCCCCCCCCCCCCCCCCCC1';
    const h = setup(`- [ ] Ship it <!-- ar:${annId} -->\n`);
    const importer = new RoadmapImporter({
      taskService: h.service,
      db: h.db,
      git: h.git,
      repo: REPO,
      log: noopLog,
    });

    // First scan: already annotated → task created, but NOT succeeded → no tick.
    importer.scan();
    let remote = readRemoteRoadmap(h.bare, h.dir);
    expect(parseRoadmapItems(remote)[0]!.checked).toBe(false);

    // Drive the task to succeeded directly in the DB.
    const task = h.db.getTaskByExternalId(annId)!;
    h.db.setTaskState(task.id, 'succeeded', Date.now());

    // Next scan: now the checkbox is ticked and pushed.
    importer.scan();
    remote = readRemoteRoadmap(h.bare, h.dir);
    const items = parseRoadmapItems(remote);
    expect(items[0]!.checked).toBe(true);
    expect(items[0]!.annotationId).toBe(annId);
  });

  it('runs git pull --ff-only before scanning (adopts a concurrently-added item)', () => {
    const h = setup('- [ ] First <!-- ar:01HDDDDDDDDDDDDDDDDDDDDDD1 -->\n');
    // A concurrent writer advances origin with a second (already annotated) item.
    const other = join(h.dir, 'other');
    git(h.dir, ['clone', h.bare, other]);
    git(other, ['config', 'user.email', 'other@example.com']);
    git(other, ['config', 'user.name', 'Other']);
    writeFileSync(
      join(other, 'ROADMAP.md'),
      '- [ ] First <!-- ar:01HDDDDDDDDDDDDDDDDDDDDDD1 -->\n- [ ] Second <!-- ar:01HDDDDDDDDDDDDDDDDDDDDDD2 -->\n',
      'utf-8'
    );
    git(other, ['add', 'ROADMAP.md']);
    git(other, ['commit', '-m', 'add second']);
    git(other, ['push', 'origin', BRANCH]);

    const importer = new RoadmapImporter({
      taskService: h.service,
      db: h.db,
      git: h.git,
      repo: REPO,
      log: noopLog,
    });
    importer.scan();

    // The pull brought in the second item, so both tasks exist.
    expect(h.db.getTaskByExternalId('01HDDDDDDDDDDDDDDDDDDDDDD1')).not.toBeNull();
    expect(h.db.getTaskByExternalId('01HDDDDDDDDDDDDDDDDDDDDDD2')).not.toBeNull();
  });

  it('on a non-fast-forward rejection, discards + re-pulls + restarts (no competing task)', () => {
    const h = setup('- [ ] Needs annotation\n');

    // Wrap the real runner so the FIRST push is forced to a non_fast_forward
    // rejection (simulating another writer winning the race); on the restart
    // we also advance origin so the re-pull adopts a winning annotation.
    const other = join(h.dir, 'other2');
    const winningId = '01HEEEEEEEEEEEEEEEEEEEEEE9';
    let pushed = false;
    const wrapped: GitRunner = {
      pullFfOnly: () => h.git.pullFfOnly(),
      readRoadmap: (p) => h.git.readRoadmap(p),
      discardLastCommit: () => h.git.discardLastCommit(),
      commitAndPush: (p, contents, msg): PushResult => {
        if (!pushed) {
          pushed = true;
          // Simulate the losing push: another writer annotated the same item.
          git(h.dir, ['clone', h.bare, other]);
          git(other, ['config', 'user.email', 'other@example.com']);
          git(other, ['config', 'user.name', 'Other']);
          writeFileSync(
            join(other, 'ROADMAP.md'),
            `- [ ] Needs annotation <!-- ar:${winningId} -->\n`,
            'utf-8'
          );
          git(other, ['add', 'ROADMAP.md']);
          git(other, ['commit', '-m', 'winner annotates']);
          git(other, ['push', 'origin', BRANCH]);
          // The importer committed locally (mirror the real runner) so the
          // subsequent discardLastCommit has a commit to undo.
          writeFileSync(join(h.clone, p), contents, 'utf-8');
          git(h.clone, ['add', p]);
          git(h.clone, ['commit', '-m', msg]);
          return 'non_fast_forward';
        }
        return h.git.commitAndPush(p, contents, msg);
      },
    };

    const importer = new RoadmapImporter({
      taskService: h.service,
      db: h.db,
      git: wrapped,
      repo: REPO,
      log: noopLog,
      newId: () => '01HEEEEEEEEEEEEEEEEEEEEEE1',
    });
    importer.scan();

    // The loser adopted the winner's annotation id — no competing task minted.
    expect(h.db.getTaskByExternalId(winningId)).not.toBeNull();
    expect(h.db.getTaskByExternalId('01HEEEEEEEEEEEEEEEEEEEEEE1')).toBeNull();
    expect(h.db.listTasks({ repo: REPO })).toHaveLength(1);
  });

  it('on a protected-branch rejection, skips write-back and derives a content-hash external_id', () => {
    const h = setup('- [ ] Protected item\n');
    const wrapped: GitRunner = {
      pullFfOnly: () => h.git.pullFfOnly(),
      readRoadmap: (p) => h.git.readRoadmap(p),
      discardLastCommit: () => h.git.discardLastCommit(),
      commitAndPush: (p, contents, msg): PushResult => {
        // Mirror the real runner: write + commit locally, then the push is
        // rejected by a protected branch.
        writeFileSync(join(h.clone, p), contents, 'utf-8');
        git(h.clone, ['add', p]);
        git(h.clone, ['commit', '-m', msg]);
        return 'protected';
      },
    };
    const importer = new RoadmapImporter({
      taskService: h.service,
      db: h.db,
      git: wrapped,
      repo: REPO,
      log: noopLog,
      newId: () => '01HFFFFFFFFFFFFFFFFFFFFFF1',
    });
    importer.scan();

    // No annotation was written to origin.
    const remote = readRemoteRoadmap(h.bare, h.dir);
    expect(parseRoadmapItems(remote)[0]!.annotationId).toBeUndefined();

    // A task was still created, keyed on a content hash (not the ULID).
    const tasks = h.db.listTasks({ repo: REPO });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.externalId!.startsWith('sha256:')).toBe(true);
    expect(h.db.getTaskByExternalId('01HFFFFFFFFFFFFFFFFFFFFFF1')).toBeNull();
  });
});
