/**
 * Pure streaming-state derivation for the live chat view (spa-overhaul Task 6 /
 * ROADMAP 76).
 *
 * The cursor (Requirement 7.2) and the per-tool-call spinner (Requirement 7.3)
 * cannot be derived from the normalized `ParsedEntry` union alone: both depend
 * on the raw entry's `source`, `type`, and — for the spinner — the ACP
 * `status` carried on a `tool_call_update`. `parseStreamEntry` deliberately
 * drops those fields. So these functions read the RAW `StreamEntry[]` (the exact
 * shape delivered by `GET /sessions/:id` and the SSE `log` frames) and compute
 * the two streaming states.
 *
 * All functions here are pure and total: they never throw and never mutate
 * their inputs. Entries MUST be in ascending event-`id` order (the same order
 * the chat view renders), which the caller guarantees.
 */

import type { StreamEntry } from './types.js';
import type { SessionStatus } from './types.js';

/** A router-source entry type that marks the current agent turn complete (7.2). */
const TURN_COMPLETE_TYPES: ReadonlySet<string> = new Set([
  'session_verified',
  'session_ended',
  'prompt_injected',
]);

/** ACP tool-call-update statuses that finish a tool call (7.3). */
const FINISHED_TOOL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed']);

/** Read a nested `update` object off a raw entry, or `undefined`. */
function readUpdate(entry: StreamEntry): Record<string, unknown> | undefined {
  const update = (entry as Record<string, unknown>).update;
  return update && typeof update === 'object' ? (update as Record<string, unknown>) : undefined;
}

/**
 * Whether a raw entry is an agent-source `agent_message_chunk` streaming update.
 * This is the "the agent is currently typing" signal the cursor tracks (7.2).
 */
function isAgentMessageChunk(entry: StreamEntry): boolean {
  if (entry.source !== 'agent' || entry.type !== 'session/update') return false;
  const update = readUpdate(entry);
  return update?.sessionUpdate === 'agent_message_chunk';
}

/**
 * Whether a raw entry is a router-source turn-complete marker
 * (`session_verified`, `session_ended`, or `prompt_injected`) (7.2).
 */
function isTurnCompleteMarker(entry: StreamEntry): boolean {
  return entry.source === 'router' && TURN_COMPLETE_TYPES.has(entry.type);
}

/**
 * Derive whether the streaming cursor glyph `▌` should be shown (Requirement
 * 7.2 / HIGH-5).
 *
 * The cursor is shown ONLY while a turn is actively streaming — that is:
 *   (a) `status === 'active'`, AND
 *   (b) there IS at least one agent-source `agent_message_chunk`, AND
 *   (c) NO turn-complete marker (`session_verified` / `session_ended` /
 *       `prompt_injected`, router source) appears AFTER the highest-`id`
 *       `agent_message_chunk`.
 *
 * For a non-active (history) load the cursor is never shown regardless of
 * content. "After" is positional in the ascending-id entry list.
 */
export function shouldShowCursor(entries: readonly StreamEntry[], status: SessionStatus): boolean {
  if (status !== 'active') return false;

  // Find the index of the LAST (highest-id) agent_message_chunk.
  let lastChunkIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && isAgentMessageChunk(entry)) {
      lastChunkIdx = i;
      break;
    }
  }
  // No agent chunk has streamed yet → nothing is streaming → no cursor.
  if (lastChunkIdx === -1) return false;

  // A turn-complete marker AFTER that chunk closes the turn → hide the cursor.
  for (let i = lastChunkIdx + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry !== undefined && isTurnCompleteMarker(entry)) return false;
  }
  return true;
}

/**
 * Compute the set of `toolCallId`s whose tool call is FINISHED — i.e. a
 * following `tool_call_update` for the same id carries an ACP `status` of
 * `'completed'` or `'failed'` (Requirement 7.3 / HIGH-C). ACP has NO
 * `complete: boolean` field; the completion signal is the `status` field on the
 * update.
 *
 * The returned set is keyed by the raw `toolCallId` string. A `tool_call` with
 * no id (null) can never be matched by an update, so it is never "finished"
 * through this path (it finishes only when the session goes inactive).
 */
export function finishedToolCallIds(entries: readonly StreamEntry[]): Set<string> {
  const finished = new Set<string>();
  for (const entry of entries) {
    if (entry === undefined) continue;
    if (entry.source !== 'agent' || entry.type !== 'session/update') continue;
    const update = readUpdate(entry);
    if (update?.sessionUpdate !== 'tool_call_update') continue;
    const toolCallId = update.toolCallId;
    const statusVal = update.status;
    if (
      typeof toolCallId === 'string' &&
      toolCallId !== '' &&
      typeof statusVal === 'string' &&
      FINISHED_TOOL_STATUSES.has(statusVal)
    ) {
      finished.add(toolCallId);
    }
  }
  return finished;
}

/**
 * Whether a specific tool-call card should show its in-progress spinner
 * (Requirement 7.3). The spinner shows ONLY when both:
 *   (a) `status === 'active'`, AND
 *   (b) the tool call is NOT finished — its id is absent from
 *       {@link finishedToolCallIds}.
 *
 * `toolCallId` is the card's id (the real ACP id, or the renderer's synthetic
 * `__synthetic_*` id for a null-id legacy call — which is never in the finished
 * set, so such a card spins while active and stops when the session goes
 * inactive, exactly as the spec requires).
 */
export function shouldShowSpinner(
  toolCallId: string,
  finished: ReadonlySet<string>,
  status: SessionStatus,
): boolean {
  if (status !== 'active') return false;
  return !finished.has(toolCallId);
}
