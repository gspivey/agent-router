import type { Database, PendingWake } from './db.js';
import type { SessionManager } from './session-mgr.js';
import type { Logger } from './log.js';
import type { AgentRouterConfig } from './config.js';
import {
  composeCheckRunPrompt,
  composeReviewCommentPrompt,
  composeCommandTriggerPrompt,
} from './prompt.js';
import type { CheckRunPayload, ReviewCommentPayload, IssueCommentPayload } from './prompt.js';

export interface PendingWakeSweeper {
  sweep(): Promise<void>;
  start(intervalMs: number): void;
  stop(): void;
}

function composePromptFromStoredEvent(eventType: string, payload: unknown): string | null {
  if (eventType === 'check_run') {
    return composeCheckRunPrompt(payload as CheckRunPayload);
  }
  if (eventType === 'pull_request_review_comment') {
    return composeReviewCommentPrompt(payload as ReviewCommentPayload);
  }
  if (eventType === 'issue_comment') {
    return composeCommandTriggerPrompt(payload as IssueCommentPayload);
  }
  return null;
}

export function createPendingWakeSweeper(deps: {
  db: Database;
  sessionMgr: SessionManager;
  config: AgentRouterConfig;
  log: Logger;
  now?: () => number;
}): PendingWakeSweeper {
  const { db, sessionMgr, config, log } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let timer: ReturnType<typeof setInterval> | null = null;

  async function deliverPendingWake(pw: PendingWake): Promise<void> {
    const session = db.findSession(pw.repo, pw.prNumber);
    if (session === null) {
      db.clearPendingWake(pw.repo, pw.prNumber);
      log.info('Pending wake dropped: no session', { repo: pw.repo, pr_number: pw.prNumber });
      return;
    }

    const handle = sessionMgr.getActiveSession(session.sessionId);
    if (handle === null) {
      db.clearPendingWake(pw.repo, pw.prNumber);
      log.info('Pending wake dropped: session not active', {
        repo: pw.repo,
        pr_number: pw.prNumber,
        session_id: session.sessionId,
      });
      return;
    }

    // Re-acquire rate-limit slot
    const acquired = db.tryAcquireWakeSlot(
      pw.repo,
      pw.prNumber,
      config.rateLimit.perPRSeconds,
      now(),
    );
    if (!acquired) {
      // Still rate-limited — leave for next sweep
      return;
    }

    const eventRow = db.getEventById(pw.eventId);
    if (eventRow === undefined) {
      db.clearPendingWake(pw.repo, pw.prNumber);
      log.warn('Pending wake dropped: event not found', { event_id: pw.eventId });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(eventRow.payload);
    } catch {
      db.clearPendingWake(pw.repo, pw.prNumber);
      log.warn('Pending wake dropped: invalid event payload', { event_id: pw.eventId });
      return;
    }

    const prompt = composePromptFromStoredEvent(eventRow.eventType, payload);
    if (prompt === null) {
      db.clearPendingWake(pw.repo, pw.prNumber);
      log.warn('Pending wake dropped: could not compose prompt', { event_id: pw.eventId });
      return;
    }

    try {
      await sessionMgr.injectPrompt(session.sessionId, prompt, 'webhook');
      db.clearPendingWake(pw.repo, pw.prNumber);
      log.info('Pending wake delivered', {
        repo: pw.repo,
        pr_number: pw.prNumber,
        session_id: session.sessionId,
        event_id: pw.eventId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      db.clearPendingWake(pw.repo, pw.prNumber);
      log.warn('Pending wake delivery failed, clearing', {
        repo: pw.repo,
        pr_number: pw.prNumber,
        error: msg,
      });
    }
  }

  const sweeper: PendingWakeSweeper = {
    async sweep(): Promise<void> {
      const due = db.getDuePendingWakes(now());
      for (const pw of due) {
        await deliverPendingWake(pw);
      }
    },

    start(intervalMs: number): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        sweeper.sweep().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('Pending wake sweep error', { error: msg });
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

  return sweeper;
}
