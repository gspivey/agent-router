import type { GitHubClient, CheckRunSummary } from './github.js';
import type { SessionManager } from './session-mgr.js';
import type { SessionFiles } from './session-files.js';
import type { Logger } from './log.js';

// ---------------------------------------------------------------------------
// Pure functions (exported for Tier 1 testing)
// ---------------------------------------------------------------------------

/** Build idempotency key for a nudge: prevents re-nudging the same outcome. */
export function nudgeKey(pr: number, headSha: string, conclusion: string): string {
  return `${pr}:${headSha}:${conclusion}`;
}

/** True when every check run in the array has status 'completed'. */
export function allTerminal(checkRuns: CheckRunSummary[]): boolean {
  if (checkRuns.length === 0) return false;
  return checkRuns.every((cr) => cr.status === 'completed');
}

/** Summarize the overall conclusion from a set of terminal check runs. */
export function summarizeConclusion(checkRuns: CheckRunSummary[]): string {
  const failed = checkRuns.filter((cr) => cr.conclusion !== 'success' && cr.conclusion !== 'skipped');
  if (failed.length === 0) return 'success';
  return 'failure';
}

// ---------------------------------------------------------------------------
// CheckWatchdog — interval-based poller
// ---------------------------------------------------------------------------

export interface CheckWatchdog {
  poll(): Promise<void>;
  start(intervalMs: number): void;
  stop(): void;
}

export function createCheckWatchdog(deps: {
  github: GitHubClient;
  sessionMgr: SessionManager;
  sessionFiles: SessionFiles;
  log: Logger;
}): CheckWatchdog {
  const { github, sessionMgr, sessionFiles, log } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;

  // In-memory set of already-delivered nudge keys
  const nudgedChecks = new Set<string>();

  async function poll(): Promise<void> {
    // Iterate over all sessions that have open registered PRs
    const allSessions = sessionFiles.listSessions();
    const activeSessions = allSessions.filter((m) => m.status === 'active');

    for (const meta of activeSessions) {
      if (meta.prs.length === 0) continue;

      const sessionId = meta.session_id;
      const handle = sessionMgr.getActiveSession(sessionId);
      if (handle === null) continue;

      for (const pr of meta.prs) {
        if (pr.merged_at !== undefined) continue; // already merged

        const slash = pr.repo.indexOf('/');
        if (slash < 1 || slash === pr.repo.length - 1) continue;
        const owner = pr.repo.slice(0, slash);
        const repo = pr.repo.slice(slash + 1);

        try {
          const pullState = await github.getPullState(owner, repo, pr.pr_number);
          if (pullState.state !== 'open') continue;
          if (pullState.headSha === null) continue;

          const checkRuns = await github.getCheckRunsForRef(owner, repo, pullState.headSha);
          if (!allTerminal(checkRuns)) continue;

          const conclusion = summarizeConclusion(checkRuns);
          const key = nudgeKey(pr.pr_number, pullState.headSha, conclusion);

          if (nudgedChecks.has(key)) continue;

          // Compose the wake prompt
          const prompt = conclusion === 'success'
            ? `CI checks are green on PR #${pr.pr_number} (head: ${pullState.headSha.slice(0, 7)}). All ${checkRuns.length} check(s) passed. Proceed with the next step.`
            : `CI checks completed on PR #${pr.pr_number} (head: ${pullState.headSha.slice(0, 7)}) with failures. Read the posted check report and fix the issues.`;

          await sessionMgr.injectPrompt(sessionId, prompt, 'router');
          nudgedChecks.add(key);

          log.info('Check watchdog: nudge delivered', {
            sessionId,
            repo: pr.repo,
            pr_number: pr.pr_number,
            headSha: pullState.headSha,
            conclusion,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('Check watchdog: GitHub error, will retry next interval', {
            sessionId,
            repo: pr.repo,
            pr_number: pr.pr_number,
            error: msg,
          });
          // Best-effort: log and continue, never crash
        }
      }
    }
  }

  const watchdog: CheckWatchdog = {
    poll,

    start(intervalMs: number): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        poll().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Check watchdog poll error', { error: msg });
        });
      }, intervalMs);
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  return watchdog;
}
