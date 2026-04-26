import type { Database } from './db.js';
import type { AgentRouterConfig } from './config.js';
import type { QueuedEvent } from './queue.js';

export type TrustTier = 'tier_1' | 'tier_2' | 'tier_3' | 'n/a';

export interface WakeDecision {
  wake: boolean;
  reason: string;
  sessionId?: string;
  prNumber?: number;
  trustTier?: TrustTier;
}

/**
 * Returns true if the comment body starts with `/agent` followed by
 * whitespace or end-of-string. Rejects `/agentsmith` etc.
 */
export function isCommandTrigger(commentBody: string): boolean {
  return /^\/agent(\s|$)/.test(commentBody);
}

/**
 * Comment author info extracted from a webhook payload.
 */
export interface CommentAuthor {
  login: string;
  type: string;
  authorAssociation: string;
}

/**
 * Compute the trust tier for a comment author relative to the repository.
 *
 * Tier 1 — full trust:
 *   - Author is the repository owner (login match OR author_association == "OWNER")
 *   - Author is github-actions[bot] (type == "Bot" AND login == "github-actions[bot]")
 *
 * Tier 2 — partial trust:
 *   - author_association is "MEMBER" or "COLLABORATOR"
 *
 * Tier 3 — untrusted:
 *   - Everything else (CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE, MANNEQUIN, unknown)
 */
export function computeTrustTier(
  author: CommentAuthor,
  repoOwnerLogin: string,
): TrustTier {
  // Tier 1: repo owner
  if (author.login === repoOwnerLogin || author.authorAssociation === 'OWNER') {
    return 'tier_1';
  }

  // Tier 1: github-actions[bot] specifically
  if (author.type === 'Bot' && author.login === 'github-actions[bot]') {
    return 'tier_1';
  }

  // Tier 2: collaborators with write access
  if (author.authorAssociation === 'MEMBER' || author.authorAssociation === 'COLLABORATOR') {
    return 'tier_2';
  }

  return 'tier_3';
}

/**
 * Extract comment author info from a parsed webhook payload.
 * Works for both issue_comment and pull_request_review_comment payloads.
 * Returns null if the required fields are missing.
 */
export function extractCommentAuthor(payload: Record<string, unknown>): CommentAuthor | null {
  const comment = payload['comment'];
  if (typeof comment !== 'object' || comment === null) return null;
  const commentObj = comment as Record<string, unknown>;

  const user = commentObj['user'];
  if (typeof user !== 'object' || user === null) return null;
  const userObj = user as Record<string, unknown>;

  const login = userObj['login'];
  const type = userObj['type'];
  if (typeof login !== 'string' || typeof type !== 'string') return null;

  const authorAssociation = commentObj['author_association'];
  if (typeof authorAssociation !== 'string') return null;

  return { login, type, authorAssociation };
}

/**
 * Extract the repository owner login from a parsed webhook payload.
 */
export function extractRepoOwnerLogin(payload: Record<string, unknown>): string | null {
  const repo = payload['repository'];
  if (typeof repo !== 'object' || repo === null) return null;
  const repoObj = repo as Record<string, unknown>;

  const owner = repoObj['owner'];
  if (typeof owner !== 'object' || owner === null) return null;
  const ownerObj = owner as Record<string, unknown>;

  const login = ownerObj['login'];
  return typeof login === 'string' ? login : null;
}

/**
 * Classify an event as wakeable based on event type, payload fields, and trust tier.
 *
 * Wakeable patterns:
 *  1. check_run with action=completed (any conclusion) — trust tier n/a
 *  2. issue_comment / pull_request_review_comment with action=created:
 *     - Tier 1: wake unconditionally
 *     - Tier 2: wake only if body starts with /agent
 *     - Tier 3: never wake
 *
 * Returns the trust tier alongside the wake decision so callers can log it.
 */
export function filterEventType(
  eventType: string,
  payload: unknown,
): { wakeable: boolean; trustTier: TrustTier } {
  if (typeof payload !== 'object' || payload === null) {
    return { wakeable: false, trustTier: 'n/a' };
  }
  const p = payload as Record<string, unknown>;

  if (eventType === 'check_run') {
    if (p['action'] !== 'completed') return { wakeable: false, trustTier: 'n/a' };
    return { wakeable: true, trustTier: 'n/a' };
  }

  if (eventType === 'pull_request_review_comment' || eventType === 'issue_comment') {
    if (p['action'] !== 'created') return { wakeable: false, trustTier: 'n/a' };

    const author = extractCommentAuthor(p);
    const repoOwnerLogin = extractRepoOwnerLogin(p);

    if (author === null || repoOwnerLogin === null) {
      // Missing trust fields — treat as tier 3 (untrusted)
      return { wakeable: false, trustTier: 'tier_3' };
    }

    const tier = computeTrustTier(author, repoOwnerLogin);

    if (tier === 'tier_1') {
      return { wakeable: true, trustTier: 'tier_1' };
    }

    if (tier === 'tier_2') {
      // Tier 2 requires /agent prefix
      const comment = p['comment'] as Record<string, unknown>;
      const body = comment['body'];
      if (typeof body === 'string' && isCommandTrigger(body)) {
        return { wakeable: true, trustTier: 'tier_2' };
      }
      return { wakeable: false, trustTier: 'tier_2' };
    }

    // Tier 3: never wake
    return { wakeable: false, trustTier: 'tier_3' };
  }

  return { wakeable: false, trustTier: 'n/a' };
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
 *   1. Filter event type + compute trust tier
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
    return { wake: false, reason: 'Invalid JSON payload', trustTier: 'n/a' };
  }

  // Step 1: Filter event type + trust tier
  const { wakeable, trustTier } = filterEventType(event.eventType, payload);
  if (!wakeable) {
    return {
      wake: false,
      reason: `Event type "${event.eventType}" is not wakeable`,
      trustTier,
    };
  }

  // Step 2: Resolve PR number
  const prNumber = resolvePRNumber(event.eventType, payload);
  if (prNumber === null) {
    return { wake: false, reason: 'Could not resolve PR number from payload', trustTier };
  }

  // Step 3: Lookup session in DB
  const session = db.findSession(event.repo, prNumber);
  if (session === null) {
    return {
      wake: false,
      reason: `No session registered for ${event.repo}#${prNumber}`,
      prNumber,
      trustTier,
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
      trustTier,
    };
  }

  return {
    wake: true,
    reason: `Wake approved for ${event.repo}#${prNumber}`,
    sessionId: session.sessionId,
    prNumber,
    trustTier,
  };
}
