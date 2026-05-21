/**
 * verifySession — the single source of truth for "did the work happen on GitHub."
 *
 * Trigger-agnostic: callers include the HTTP /hooks/event endpoint, the
 * post-`sendPrompt` ACP fallback, the inactivity watchdog, and the
 * `complete_session` MCP path. All funnel here.
 *
 * Write-idempotent: a session that already has `termination_reason` set is
 * a no-op on subsequent calls.
 *
 * Concurrency-safe: per-session single-flight via a `Map<sessionId, Promise>`.
 * Entries are removed on settlement, so the map cannot grow unbounded.
 *
 * Authority: `termination_reason` is computed from GitHub state alone — never
 * from agent input. This is the structural fix for the bug class where an
 * agent could claim merge while a PR was still open.
 */
import type { Logger } from './log.js';
import type { SessionFiles } from './session-files.js';
import type { GitHubClient, PullState } from './github.js';

export type VerifyResult =
  | { verified: true; termination_reason: 'merged' | 'closed_without_merge' }
  | { verified: false; reason: 'github_error'; error: string }
  | { verified: false; reason: 'prs_still_open'; open_prs: Array<{ repo: string; pr_number: number }> }
  | { verified: false; reason: 'already_verified' }
  | { verified: false; reason: 'no_prs' }
  | { verified: false; reason: 'unknown_session' };

export type VerifySessionFn = (sessionId: string) => Promise<VerifyResult>;

function splitRepo(repo: string): { owner: string; name: string } | null {
  const slash = repo.indexOf('/');
  if (slash < 1 || slash === repo.length - 1) return null;
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

export function createVerifier(deps: {
  sessionFiles: SessionFiles;
  github: GitHubClient;
  log: Logger;
}): VerifySessionFn {
  const { sessionFiles, github, log } = deps;
  const inFlight = new Map<string, Promise<VerifyResult>>();

  return async function verifySession(sessionId: string): Promise<VerifyResult> {
    const existing = inFlight.get(sessionId);
    if (existing) return existing;

    const promise = (async (): Promise<VerifyResult> => {
      if (!sessionFiles.sessionExists(sessionId)) {
        log.debug('verifySession: unknown session', { sessionId });
        return { verified: false, reason: 'unknown_session' };
      }

      const meta = sessionFiles.readMeta(sessionId);

      if (meta.termination_reason !== undefined && meta.termination_reason !== null) {
        log.debug('verifySession: already verified', {
          sessionId,
          termination_reason: meta.termination_reason,
        });
        return { verified: false, reason: 'already_verified' };
      }

      if (meta.prs.length === 0) {
        log.info('verifySession: no registered PRs, skipping', { sessionId });
        return { verified: false, reason: 'no_prs' };
      }

      const states: Array<{ pr: { repo: string; pr_number: number }; state: PullState }> = [];
      for (const pr of meta.prs) {
        const parts = splitRepo(pr.repo);
        if (parts === null) {
          log.warn('verifySession: malformed repo in registered PR, skipping', {
            sessionId,
            repo: pr.repo,
            pr_number: pr.pr_number,
          });
          continue;
        }
        try {
          const state = await github.getPullState(parts.owner, parts.name, pr.pr_number);
          states.push({ pr: { repo: pr.repo, pr_number: pr.pr_number }, state });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('verifySession: GitHub query failed', {
            sessionId,
            repo: pr.repo,
            pr_number: pr.pr_number,
            error: message,
          });
          try {
            sessionFiles.appendStream(sessionId, {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'verification_failed',
              repo: pr.repo,
              pr_number: pr.pr_number,
              error: message,
            });
          } catch {
            // best-effort; don't escalate stream-write failures
          }
          return { verified: false, reason: 'github_error', error: message };
        }
      }

      const openPRs = states
        .filter((s) => s.state.state === 'open')
        .map((s) => s.pr);
      if (openPRs.length > 0) {
        log.info('verifySession: PRs still open', { sessionId, open_prs: openPRs });
        return { verified: false, reason: 'prs_still_open', open_prs: openPRs };
      }

      const allMerged = states.every((s) => s.state.merged);
      const termination_reason: 'merged' | 'closed_without_merge' = allMerged
        ? 'merged'
        : 'closed_without_merge';

      sessionFiles.updateMeta(sessionId, {
        status: 'completed',
        completed_at: Math.floor(Date.now() / 1000),
        termination_reason,
      });

      try {
        sessionFiles.appendStream(sessionId, {
          ts: new Date().toISOString(),
          source: 'router',
          type: 'session_verified',
          termination_reason,
          prs: meta.prs.map((p) => ({ repo: p.repo, pr_number: p.pr_number })),
        });
      } catch {
        // best-effort; the meta.json write is authoritative
      }

      log.info('Session verified', { sessionId, termination_reason });
      return { verified: true, termination_reason };
    })();

    inFlight.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(sessionId);
    }
  };
}
