/**
 * Comment tracker: parse outbound comment IDs from agent tool call output.
 *
 * Detects comment IDs from two patterns:
 *   1. `gh pr comment` / `gh issue comment` — outputs a URL like
 *      https://github.com/owner/repo/pull/42#issuecomment-1234567890
 *      or https://github.com/owner/repo/issues/42#issuecomment-1234567890
 *   2. `gh api repos/.../comments` — outputs JSON with an `id` field
 *
 * Also detects `gh pr review` which creates review comments.
 *
 * Pure functions — no side effects, fully unit-testable.
 */

export interface ParsedComment {
  commentId: number;
  repo: string;
  prNumber: number;
}

/**
 * Extract a comment ID from a GitHub comment URL.
 *
 * Matches URLs like:
 *   https://github.com/owner/repo/pull/42#issuecomment-1234567890
 *   https://github.com/owner/repo/issues/42#issuecomment-1234567890
 */
export function parseCommentUrl(text: string): ParsedComment | null {
  const match = text.match(
    /https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)#issuecomment-(\d+)/,
  );
  if (match === null) return null;

  const repo = match[1]!;
  const prNumber = parseInt(match[2]!, 10);
  const commentId = parseInt(match[3]!, 10);

  if (isNaN(commentId) || isNaN(prNumber)) return null;

  return { commentId, repo, prNumber };
}

/**
 * Extract a comment ID from a GitHub API JSON response.
 *
 * Looks for `"id": <number>` in JSON output from commands like:
 *   gh api repos/owner/repo/issues/42/comments --method POST ...
 *
 * Only parses if the text looks like a JSON object with an `id` field.
 */
export function parseCommentJson(text: string): number | null {
  // Try to find a JSON object in the text (must start with '{', not '[')
  const jsonStart = text.indexOf('{');
  if (jsonStart === -1) return null;

  // Reject if the first JSON structure is an array
  const arrayStart = text.indexOf('[');
  if (arrayStart !== -1 && arrayStart < jsonStart) return null;

  // Find the matching closing brace (simple heuristic: last } in text)
  const jsonEnd = text.lastIndexOf('}');
  if (jsonEnd <= jsonStart) return null;

  const jsonStr = text.slice(jsonStart, jsonEnd + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const id = obj['id'];

  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return null;
  }

  return id;
}

/**
 * Determine if a command string is a GitHub comment-producing command.
 *
 * Matches:
 *   - gh pr comment ...
 *   - gh issue comment ...
 *   - gh pr review ...
 *   - gh api repos/.../comments ... --method POST
 *   - gh api repos/.../reviews ... --method POST
 */
export function isCommentCommand(command: string): boolean {
  // gh pr comment / gh issue comment / gh pr review
  if (/\bgh\s+(?:pr|issue)\s+(?:comment|review)\b/.test(command)) {
    return true;
  }

  // gh api with comments or reviews endpoint and POST method
  if (/\bgh\s+api\b/.test(command) && /\b(?:comments|reviews)\b/.test(command)) {
    return true;
  }

  return false;
}

/**
 * Extract all comment IDs from tool call output text.
 *
 * Tries both URL parsing and JSON parsing. Returns all found comment IDs.
 */
export function extractCommentIds(output: string): ParsedComment[] {
  const results: ParsedComment[] = [];

  // Try URL pattern (can appear multiple times in output)
  const urlRegex =
    /https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)#issuecomment-(\d+)/g;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRegex.exec(output)) !== null) {
    const repo = urlMatch[1]!;
    const prNumber = parseInt(urlMatch[2]!, 10);
    const commentId = parseInt(urlMatch[3]!, 10);
    if (!isNaN(commentId) && !isNaN(prNumber)) {
      results.push({ commentId, repo, prNumber });
    }
  }

  // Try JSON pattern if no URL matches found
  if (results.length === 0) {
    const jsonId = parseCommentJson(output);
    if (jsonId !== null) {
      // Without URL context we don't know repo/pr, but we still track the ID
      // The caller will need to supply repo/pr from context
      results.push({ commentId: jsonId, repo: '', prNumber: 0 });
    }
  }

  return results;
}
