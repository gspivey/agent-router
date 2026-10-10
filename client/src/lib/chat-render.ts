/**
 * Pure transform from the ordered `ParsedEntry` stream into the renderable item
 * list the chat view draws (spa-overhaul Task 5 / ROADMAP 75).
 *
 * Two foldings happen here (design: "Bubble reassembly"):
 *
 *  1. **Agent chunk reassembly.** Consecutive `agent_chunk` entries that belong
 *     to the same turn are concatenated into a single `MessageBubble` item. Any
 *     non-chunk entry (`agent_message`, `system`, `tool_call`, `permission`,
 *     `internal`, `unknown`) closes the open chunk bubble.
 *
 *  2. **Tool-update folding.** `tool_update` entries are matched to their
 *     `tool_call` by `toolCallId` and their text appended to that card's body.
 *     A `tool_call` with `toolCallId === null` gets a synthetic id so updates
 *     cannot cross-contaminate between distinct null-id calls (there are none to
 *     match against, so each null card stands alone). A `tool_update` whose
 *     `toolCallId` has no preceding `tool_call` is dropped (nothing to fold into)
 *     rather than rendered as a stray card.
 *
 * The input must already be in ascending event-`id` order (Requirement 6.9); the
 * output preserves that order. This function is pure and total.
 */

import type { ParsedEntry, SystemBadge } from './logic.js';

/** A reassembled agent bubble (one or more `agent_chunk`/`agent_message`). */
export interface BubbleItem {
  kind: 'bubble';
  key: string;
  text: string;
}

/** A centered system pill. */
export interface SystemItem {
  kind: 'system';
  key: string;
  text: string;
  badge?: SystemBadge;
}

/** A tool-call card with its folded `tool_update` body. */
export interface ToolCallItem {
  kind: 'tool_call';
  key: string;
  toolCallId: string;
  title: string;
  updates: string;
}

/** A read-only permission card. */
export interface PermissionItem {
  kind: 'permission';
  key: string;
  title: string;
}

/** A minimized internal metadata pill. */
export interface InternalItem {
  kind: 'internal';
  key: string;
  text: string;
}

/** An unknown-type pill (type label only, no payload). */
export interface UnknownItem {
  kind: 'unknown';
  key: string;
  typeLabel: string;
}

export type RenderItem =
  | BubbleItem
  | SystemItem
  | ToolCallItem
  | PermissionItem
  | InternalItem
  | UnknownItem;

/**
 * Build the ordered render-item list from the parsed entries (ascending id).
 *
 * `ids[i]` is the SSE id of `entries[i]`; it is used only to build stable keys
 * so Svelte's keyed `{#each}` reconciles correctly. When `ids` is omitted the
 * array index is used as the key.
 */
export function buildRenderItems(entries: readonly ParsedEntry[], ids?: readonly number[]): RenderItem[] {
  const items: RenderItem[] = [];
  // The currently open agent-chunk bubble, if any.
  let openBubble: BubbleItem | null = null;
  // Map from toolCallId → its card item so updates fold into the right card.
  const toolCards = new Map<string, ToolCallItem>();
  let syntheticToolSeq = 0;

  const keyAt = (i: number): string => `e${ids?.[i] ?? i}`;

  const closeBubble = (): void => {
    openBubble = null;
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const key = keyAt(i);

    switch (entry.kind) {
      case 'agent_chunk': {
        if (openBubble) {
          openBubble.text += entry.text;
        } else {
          openBubble = { kind: 'bubble', key, text: entry.text };
          items.push(openBubble);
        }
        break;
      }
      case 'agent_message': {
        // A flat legacy message is its own bubble and does NOT join reassembly.
        closeBubble();
        items.push({ kind: 'bubble', key, text: entry.text });
        break;
      }
      case 'system': {
        closeBubble();
        const item: SystemItem = { kind: 'system', key, text: entry.text };
        if (entry.badge !== undefined) item.badge = entry.badge;
        items.push(item);
        break;
      }
      case 'tool_call': {
        closeBubble();
        // Give a null id a synthetic, collision-free key so no update folds in.
        const id = entry.toolCallId ?? `__synthetic_${syntheticToolSeq++}`;
        const card: ToolCallItem = {
          kind: 'tool_call',
          key,
          toolCallId: id,
          title: entry.title,
          updates: '',
        };
        toolCards.set(id, card);
        items.push(card);
        break;
      }
      case 'tool_update': {
        // Fold into the matching card; drop silently if there is no match.
        const card = toolCards.get(entry.toolCallId);
        if (card) card.updates += entry.text;
        break;
      }
      case 'permission': {
        closeBubble();
        items.push({ kind: 'permission', key, title: entry.title });
        break;
      }
      case 'internal': {
        closeBubble();
        items.push({ kind: 'internal', key, text: entry.text });
        break;
      }
      case 'unknown': {
        closeBubble();
        items.push({ kind: 'unknown', key, typeLabel: entry.typeLabel });
        break;
      }
    }
  }

  return items;
}
