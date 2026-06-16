/**
 * Pure session-id prefix resolution.
 *
 * Accepts any unambiguous prefix of a session UUID and resolves it to the
 * full ID. Errors on zero matches (no such session) or multiple matches
 * (ambiguous prefix — includes candidate list).
 */

export type SessionIdResult =
  | { readonly kind: 'match'; readonly sessionId: string }
  | { readonly kind: 'no_match' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] };

/**
 * Resolve a session-id prefix against a list of known session IDs.
 *
 * - If exactly one candidate starts with `prefix`, returns `{ kind: 'match' }`.
 * - If zero candidates match, returns `{ kind: 'no_match' }`.
 * - If multiple candidates match, returns `{ kind: 'ambiguous', candidates }`.
 */
export function resolveSessionId(
  prefix: string,
  candidates: readonly string[],
): SessionIdResult {
  const matches = candidates.filter((id) => id.startsWith(prefix));

  if (matches.length === 1) {
    return { kind: 'match', sessionId: matches[0]! };
  }
  if (matches.length === 0) {
    return { kind: 'no_match' };
  }
  return { kind: 'ambiguous', candidates: matches };
}
