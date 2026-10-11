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

/**
 * The JSON-pivot source for a render item (spa-overhaul Task 7 / ROADMAP 77).
 *
 * `json` is the pretty-printed raw stream entry (or entries, for a reassembled
 * bubble) that produced the item, ready for the `JsonToggle` `<pre>` view
 * (Requirement 8.2). It is populated only when the caller passes `raws` to
 * `buildRenderItems`; otherwise it is the empty string so historical callers and
 * pure-logic tests that omit `raws` keep working unchanged. For a bubble built
 * from several `agent_chunk` entries, `json` is the JSON array of all the raw
 * entries that fold into that bubble; for every other kind it is the single raw
 * entry object.
 */
interface JsonSource {
  /** `JSON.stringify(rawEntry(s), null, 2)`, or '' when no raws were provided. */
  json: string;
  /**
   * The raw `StreamEntry.source` string of the entry that produced this item
   * (spa-operator-restoration Task B-7 / ROADMAP 81). Used by `ChatView` to
   * filter Kiro-internal entries (`source` starting with `_kiro.dev/`) when the
   * "Show internals" toggle is OFF (FR-4.1). Undefined when no `raws` were
   * provided or the raw entry has no string `source`. For a reassembled bubble
   * it is the `source` of the first folded chunk.
   */
  rawSource?: string;
}

/** A reassembled agent bubble (one or more `agent_chunk`/`agent_message`). */
export interface BubbleItem extends JsonSource {
  kind: 'bubble';
  key: string;
  text: string;
}

/** A centered system pill. */
export interface SystemItem extends JsonSource {
  kind: 'system';
  key: string;
  text: string;
  badge?: SystemBadge;
}

/** A tool-call card with its folded `tool_update` body. */
export interface ToolCallItem extends JsonSource {
  kind: 'tool_call';
  key: string;
  toolCallId: string;
  title: string;
  updates: string;
}

/** A read-only permission card. */
export interface PermissionItem extends JsonSource {
  kind: 'permission';
  key: string;
  title: string;
}

/** A minimized internal metadata pill. */
export interface InternalItem extends JsonSource {
  kind: 'internal';
  key: string;
  text: string;
}

/** An unknown-type pill (type label only, no payload). */
export interface UnknownItem extends JsonSource {
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

/** Pretty-print a single raw entry (or '' when none is available). */
function stringifyRaw(raw: unknown): string {
  if (raw === undefined) return '';
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return '';
  }
}

/**
 * Extract the `source` string from a raw stream entry, or undefined when the
 * entry is missing or has no string `source` (spa-operator-restoration B-7).
 */
function rawSourceOf(raw: unknown): string | undefined {
  if (raw !== null && typeof raw === 'object' && 'source' in raw) {
    const src = (raw as { source: unknown }).source;
    if (typeof src === 'string') return src;
  }
  return undefined;
}

/** Pretty-print the collected raw entries of a reassembled bubble. */
function stringifyRaws(raws: unknown[]): string {
  if (raws.length === 0) return '';
  // A single-chunk bubble serializes as the bare entry; a multi-chunk bubble as
  // the array of the raw entries that fold into it.
  const value = raws.length === 1 ? raws[0] : raws;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

/**
 * Build the ordered render-item list from the parsed entries (ascending id).
 *
 * `ids[i]` is the SSE id of `entries[i]`; it is used only to build stable keys
 * so Svelte's keyed `{#each}` reconciles correctly. When `ids` is omitted the
 * array index is used as the key.
 *
 * `raws[i]` is the RAW stream entry that produced `entries[i]` (the SPA passes
 * the untouched `StreamEntry` objects here). It feeds the per-item `json`
 * field that the `JsonToggle` pivots to (Requirement 8.2). When `raws` is
 * omitted, every item's `json` is '' and nothing else changes, so pure-logic
 * tests that only care about the rendered shape stay unaffected.
 */
export function buildRenderItems(
  entries: readonly ParsedEntry[],
  ids?: readonly number[],
  raws?: readonly unknown[],
): RenderItem[] {
  const items: RenderItem[] = [];
  // The currently open agent-chunk bubble, if any, plus the raw entries that
  // have folded into it (so its JSON pivot shows every chunk).
  let openBubble: BubbleItem | null = null;
  let openBubbleRaws: unknown[] = [];
  // Map from toolCallId → its card item so updates fold into the right card.
  const toolCards = new Map<string, ToolCallItem>();
  let syntheticToolSeq = 0;

  const keyAt = (i: number): string => `e${ids?.[i] ?? i}`;
  const rawAt = (i: number): unknown => raws?.[i];

  const closeBubble = (): void => {
    if (openBubble) openBubble.json = stringifyRaws(openBubbleRaws);
    openBubble = null;
    openBubbleRaws = [];
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const key = keyAt(i);
    const raw = rawAt(i);
    const src = rawSourceOf(raw);

    switch (entry.kind) {
      case 'agent_chunk': {
        if (openBubble) {
          openBubble.text += entry.text;
          openBubbleRaws.push(raw);
        } else {
          openBubble = { kind: 'bubble', key, text: entry.text, json: '' };
          if (src !== undefined) openBubble.rawSource = src;
          openBubbleRaws = [raw];
          items.push(openBubble);
        }
        break;
      }
      case 'agent_message': {
        // A flat legacy message is its own bubble and does NOT join reassembly.
        closeBubble();
        items.push({ kind: 'bubble', key, text: entry.text, json: stringifyRaw(raw), ...(src !== undefined ? { rawSource: src } : {}) });
        break;
      }
      case 'system': {
        closeBubble();
        const item: SystemItem = { kind: 'system', key, text: entry.text, json: stringifyRaw(raw) };
        if (src !== undefined) item.rawSource = src;
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
          json: stringifyRaw(raw),
        };
        if (src !== undefined) card.rawSource = src;
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
        items.push({ kind: 'permission', key, title: entry.title, json: stringifyRaw(raw), ...(src !== undefined ? { rawSource: src } : {}) });
        break;
      }
      case 'internal': {
        closeBubble();
        items.push({ kind: 'internal', key, text: entry.text, json: stringifyRaw(raw), ...(src !== undefined ? { rawSource: src } : {}) });
        break;
      }
      case 'unknown': {
        closeBubble();
        items.push({ kind: 'unknown', key, typeLabel: entry.typeLabel, json: stringifyRaw(raw), ...(src !== undefined ? { rawSource: src } : {}) });
        break;
      }
    }
  }

  // Finalize any bubble still open at end of stream.
  closeBubble();

  return items;
}
