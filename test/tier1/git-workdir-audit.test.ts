/**
 * Tier 1 guard test (task 84.7 point 5 / FR-3.4 step 5): the daemon MUST NOT
 * run git with a cwd inside a session's `work/` directory. The agent controls
 * `.git/config` there, so a daemon-side git call would execute attacker hooks
 * as `agentrouter`.
 *
 * This scanner inspects every git invocation in `worktree-manager.ts` and
 * `attempt-runner.ts` that passes a `cwd`. Each such call site MUST be
 * annotated with a `DAEMON_GIT_WORKDIR_AUDITED:` comment within the preceding
 * few lines, OR invoke git via `sudo ... -u agentworker`. Any unaudited
 * git-with-cwd call fails the test, forcing a human to re-audit when a new one
 * is introduced.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../../src');

const FILES = ['worktree-manager.ts', 'attempt-runner.ts'];

/** Lines that start a git invocation with potential cwd risk. */
function findGitCwdCallLines(source: string): number[] {
  const lines = source.split('\n');
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // A git invocation: execFile/execFileSync/execFileAsync/run(..., 'git'/"git", ...)
    // or a direct `git` first-arg. We only care about calls that also pass a cwd.
    const isGitCall = /\b(execFile|execFileSync|execFileAsync|run)\s*\(\s*(git\b|['"]git['"])/.test(line);
    if (!isGitCall) continue;
    // Look ahead a few lines for a `cwd:` option on the same call.
    const window = lines.slice(i, i + 8).join('\n');
    if (/\bcwd\s*:/.test(window)) {
      hits.push(i);
    }
  }
  return hits;
}

/** True if the call at `lineIdx` is audited or routed through sudo agentworker. */
function isAuditedOrSudo(source: string, lineIdx: number): boolean {
  const lines = source.split('\n');
  // Audit comment within the preceding 4 lines.
  const preceding = lines.slice(Math.max(0, lineIdx - 4), lineIdx + 1).join('\n');
  if (preceding.includes('DAEMON_GIT_WORKDIR_AUDITED')) return true;
  // Or the call itself routes through sudo -u agentworker.
  const window = lines.slice(lineIdx, lineIdx + 8).join('\n');
  if (/sudo[^\n]*-u[^\n]*agentworker/.test(window)) return true;
  return false;
}

describe('daemon git-in-workdir audit (FR-3.4 step 5)', () => {
  for (const file of FILES) {
    it(`every git-with-cwd call in ${file} is audited or sudo-agentworker`, () => {
      const full = path.join(srcDir, file);
      expect(fs.existsSync(full)).toBe(true);
      const source = fs.readFileSync(full, 'utf-8');
      const hits = findGitCwdCallLines(source);
      const unaudited: number[] = [];
      for (const idx of hits) {
        if (!isAuditedOrSudo(source, idx)) unaudited.push(idx + 1); // 1-based line
      }
      expect(unaudited, `unaudited git-with-cwd call sites (1-based lines): ${unaudited.join(', ')}`).toEqual([]);
    });
  }

  it('the scanner actually detects an unaudited sample (self-check)', () => {
    const sample = [
      'function x() {',
      "  execFileSync('git', ['status'], { cwd: workDir });",
      '}',
    ].join('\n');
    const hits = findGitCwdCallLines(sample);
    expect(hits.length).toBe(1);
    expect(isAuditedOrSudo(sample, hits[0]!)).toBe(false);
  });
});
