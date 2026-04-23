import type { Database } from './db.js';
import type { AgentRouterConfig } from './config.js';
import type { QueuedEvent } from './queue.js';

export interface WakeDecision {
  wake: boolean;
  reason: string;
  sessionId?: string;
  prNumber?: number;
}

/**
 * Returns true if the comment body starts with `/agent` followed by
 * whitespace or end-of-string. Rejects `/agentsmith` etc.
 */
export function isCommandTrigger(commentBody: string): boolean {
  return /^\/agent(\s|$)/.test(commentBody);
}

/**
 * Classify an event as wakeable based on event type + payload fields.
 *
 * Wakeable patterns:
 *  1. check_run  with action=completed, conclusion=failure
 *  2. pull_request_review_comment  with action=created
 *  3. issue_comment  with action=created and body matching /^\/agent(\s|$)/
 */
export function filterEventType(eventType: string, payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }
  const p = payload as Record<string, unknown>;

  if (eventType === 'check_run') {
    if (p['action'] !== 'completed') return false;
    const checkRun = p['check_run'];
    if (typeof checkRun !== 'object' || checkRun === null) return false;
    return (checkRun as Record<string, unknown>)['conclusion'] === 'failure';
  }

  if (eventType === 'pull_request_review_comment') {
    return p['action'] === 'created';
  }

  if (eventType === 'issue_comment') {
    if (p['action'] !== 'created') return false;
    const comment = p['comment'];
    if (typeof comment !== 'object' || comment === null) return false;
    const body = (comment as Record<string, unknown>)['body'];
    if (typeof body !== 'string') return false;
    return isCommandTrigger(body);
  }

  return false;
}

/**
 * Extract the PR number from the webhook payload based on event type.
 * Returns null when the PR number cannot be determined.
 */
export function resolvePRNumber(eventType: string, payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const p = payload as Record<string, unknown>;

  if (eventType === 'pull_request_review_comment') {
    const pr = p['pull_request'];
    if (typeof pr !== 'object' || pr === null) return null;
    const num = (pr as Record<string, unknown>)['number'];
    return typeof num === 'number' ? num : null;
  }

  if (eventType === 'issue_comment') {
    const issue = p['issue'];
    if (typeof issue !== 'object' || issue === null) return null;
    const issueObj = issue as Record<string, unknown>;
    // Must have issue.pull_request to confirm it's a PR comment
    if (!issueObj['pull_request']) return null;
    const num = issueObj['number'];
    return typeof num === 'number' ? num : null;
  }

  if (eventType === 'check_run') {
    const checkRun = p['check_run'];
    if (typeof checkRun !== 'object' || checkRun === null) return null;
    const prs = (checkRun as Record<string, unknown>)['pull_requests'];
    if (!Array.isArray(prs) || prs.length === 0) return null;
    const first = prs[0] as unknown;
    if (typeof first !== 'object' || first === null) return null;
    const num = (first as Record<string, unknown>)['number'];
    return typeof num === 'number' ? num : null;
  }

  return null;
}

/**
 * Orchestrate the full wake policy pipeline:
 *   1. Filter event type
 *   2. Resolve PR number
 *   3. Lookup session in DB
 *   4. Check rate limit via db.tryAcquireWakeSlot
 *
 * Each step short-circuits with a "no wake" decision on failure.
 */
export function evaluateWakePolicy(
  event: QueuedEvent,
  db: Database,
  config: AgentRouterConfig,
): WakeDecision {
  // Parse the payload string into an object
  let payload: unknown;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    return { wake: false, reason: 'Invalid JSON payload' };
  }

  // Step 1: Filter event type
  if (!filterEventType(event.eventType, payload)) {
    return { wake: false, reason: `Event type "${event.eventType}" is not wakeable` };
  }

  // Step 2: Resolve PR number
  const prNumber = resolvePRNumber(event.eventType, payload);
  if (prNumber === null) {
    return { wake: false, reason: 'Could not resolve PR number from payload' };
  }

  // Step 3: Lookup session in DB
  const session = db.findSession(event.repo, prNumber);
  if (session === null) {
    return {
      wake: false,
      reason: `No session registered for ${event.repo}#${prNumber}`,
      prNumber,
    };
  }

  // Step 4: Rate limit check (atomically acquires the slot if allowed)
  const nowSeconds = Math.floor(Date.now() / 1000);
  const acquired = db.tryAcquireWakeSlot(
    event.repo,
    prNumber,
    config.rateLimit.perPRSeconds,
    nowSeconds,
  );
  if (!acquired) {
    return {
      wake: false,
      reason: `Rate limited: ${event.repo}#${prNumber} was waked too recently`,
      sessionId: session.sessionId,
      prNumber,
    };
  }

  return {
    wake: true,
    reason: `Wake approved for ${event.repo}#${prNumber}`,
    sessionId: session.sessionId,
    prNumber,
  };
}
