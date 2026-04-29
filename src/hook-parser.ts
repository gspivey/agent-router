/**
 * Hook event parser for Kiro postToolUse events.
 *
 * Detects successful `gh pr merge` commands from tool call results
 * and returns a completion signal when matched.
 *
 * Pure functions — no side effects, fully unit-testable.
 */

export interface HookEvent {
  command: string;
  exitCode: number;
}

export interface CompletionSignal {
  shouldComplete: boolean;
  reason: 'merged';
}

const NO_COMPLETION: CompletionSignal = { shouldComplete: false, reason: 'merged' };
const MERGED: CompletionSignal = { shouldComplete: true, reason: 'merged' };

/**
 * Parse a postToolUse hook event JSON string into a HookEvent.
 * Returns null if the JSON is invalid or doesn't contain the expected fields.
 */
export function parseHookEvent(json: string): HookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Try multiple possible shapes for the hook event:
  // Shape 1: { input: { command }, output: { exitCode } }
  // Shape 2: { command, exitCode }
  // Shape 3: { toolInput: { command }, toolOutput: { exitCode } }

  let command: string | undefined;
  let exitCode: number | undefined;

  const input = obj['input'] as Record<string, unknown> | undefined;
  const output = obj['output'] as Record<string, unknown> | undefined;
  const toolInput = obj['toolInput'] as Record<string, unknown> | undefined;
  const toolOutput = obj['toolOutput'] as Record<string, unknown> | undefined;

  if (typeof input?.['command'] === 'string') {
    command = input['command'];
  } else if (typeof toolInput?.['command'] === 'string') {
    command = toolInput['command'];
  } else if (typeof obj['command'] === 'string') {
    command = obj['command'];
  }

  if (typeof output?.['exitCode'] === 'number') {
    exitCode = output['exitCode'];
  } else if (typeof toolOutput?.['exitCode'] === 'number') {
    exitCode = toolOutput['exitCode'];
  } else if (typeof obj['exitCode'] === 'number') {
    exitCode = obj['exitCode'];
  }

  if (command === undefined || exitCode === undefined) {
    return null;
  }

  return { command, exitCode };
}

/**
 * Determine whether a parsed hook event represents a successful `gh pr merge`.
 *
 * Matches commands containing `gh pr merge` with exit code 0.
 * Handles common patterns:
 *   - `gh pr merge 42`
 *   - `gh pr merge --squash`
 *   - `gh pr merge 42 --squash --delete-branch`
 *   - Piped commands: `gh pr merge 42 && echo done`
 */
export function detectMergeCompletion(event: HookEvent): CompletionSignal {
  if (event.exitCode !== 0) {
    return NO_COMPLETION;
  }

  // Match `gh pr merge` anywhere in the command string
  if (/\bgh\s+pr\s+merge\b/.test(event.command)) {
    return MERGED;
  }

  return NO_COMPLETION;
}

/**
 * End-to-end: parse JSON and check for merge completion.
 */
export function checkHookEventForCompletion(json: string): CompletionSignal {
  const event = parseHookEvent(json);
  if (event === null) {
    return NO_COMPLETION;
  }
  return detectMergeCompletion(event);
}
