import { describe, it, expect } from 'vitest';
import { buildRenderItems } from './chat-render.js';
import type { ParsedEntry } from './logic.js';

/**
 * Pure chat-render transform tests (spa-overhaul Task 5 / ROADMAP 75).
 *
 * Covers agent-chunk reassembly, tool-update folding by `toolCallId`, order
 * preservation (Req 6.9), and the taxonomy → item mapping (Req 6.1–6.7).
 */

describe('buildRenderItems', () => {
  it('reassembles consecutive agent chunks into one bubble (Req 6.2)', () => {
    const entries: ParsedEntry[] = [
      { kind: 'agent_chunk', text: 'Hello ', streaming: true },
      { kind: 'agent_chunk', text: 'there', streaming: true },
      { kind: 'agent_chunk', text: '!', streaming: true },
    ];
    const items = buildRenderItems(entries, [1, 2, 3]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'bubble', text: 'Hello there!' });
  });

  it('a non-chunk entry closes the open bubble', () => {
    const entries: ParsedEntry[] = [
      { kind: 'agent_chunk', text: 'first', streaming: true },
      { kind: 'system', subtype: 'session_started', text: 'Session started' },
      { kind: 'agent_chunk', text: 'second', streaming: true },
    ];
    const items = buildRenderItems(entries, [1, 2, 3]);
    expect(items.map((i) => i.kind)).toEqual(['bubble', 'system', 'bubble']);
    expect(items[0]).toMatchObject({ text: 'first' });
    expect(items[2]).toMatchObject({ text: 'second' });
  });

  it('a flat agent_message is its own bubble and does not join reassembly', () => {
    const entries: ParsedEntry[] = [
      { kind: 'agent_chunk', text: 'chunk', streaming: true },
      { kind: 'agent_message', text: 'flat', streaming: false },
    ];
    const items = buildRenderItems(entries, [1, 2]);
    expect(items.map((i) => i.kind)).toEqual(['bubble', 'bubble']);
    expect(items[0]).toMatchObject({ text: 'chunk' });
    expect(items[1]).toMatchObject({ text: 'flat' });
  });

  it('folds tool_update text into the matching tool_call card by toolCallId (Req 6.4)', () => {
    const entries: ParsedEntry[] = [
      { kind: 'tool_call', toolCallId: 'tc1', title: 'read_file' },
      { kind: 'tool_update', toolCallId: 'tc1', text: 'line 1\n' },
      { kind: 'tool_update', toolCallId: 'tc1', text: 'line 2' },
    ];
    const items = buildRenderItems(entries, [1, 2, 3]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool_call',
      title: 'read_file',
      updates: 'line 1\nline 2',
    });
  });

  it('routes tool_update to the correct card when two calls interleave', () => {
    const entries: ParsedEntry[] = [
      { kind: 'tool_call', toolCallId: 'a', title: 'A' },
      { kind: 'tool_call', toolCallId: 'b', title: 'B' },
      { kind: 'tool_update', toolCallId: 'b', text: 'B-out' },
      { kind: 'tool_update', toolCallId: 'a', text: 'A-out' },
    ];
    const items = buildRenderItems(entries, [1, 2, 3, 4]);
    const cards = items.filter((i) => i.kind === 'tool_call');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ title: 'A', updates: 'A-out' });
    expect(cards[1]).toMatchObject({ title: 'B', updates: 'B-out' });
  });

  it('drops a tool_update with no matching tool_call (no stray card)', () => {
    const entries: ParsedEntry[] = [
      { kind: 'tool_update', toolCallId: 'orphan', text: 'nowhere' },
    ];
    const items = buildRenderItems(entries, [1]);
    expect(items).toHaveLength(0);
  });

  it('gives a null-id tool_call a synthetic key so updates never fold in', () => {
    const entries: ParsedEntry[] = [
      { kind: 'tool_call', toolCallId: null, title: 'bare' },
      { kind: 'tool_update', toolCallId: '', text: 'ignored' },
    ];
    const items = buildRenderItems(entries, [1, 2]);
    const cards = items.filter((i) => i.kind === 'tool_call');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: 'bare', updates: '' });
  });

  it('maps every parsed kind to its render item and preserves order (Req 6.1-6.7, 6.9)', () => {
    const entries: ParsedEntry[] = [
      { kind: 'system', subtype: 'session_verified', text: 'Verified — merged', badge: 'green' },
      { kind: 'tool_call', toolCallId: 'tc', title: 'run' },
      { kind: 'permission', title: 'approve shell' },
      { kind: 'internal', subtype: '_kiro.dev/metadata', text: 'Context 42%' },
      { kind: 'unknown', typeLabel: 'weird' },
      { kind: 'agent_message', text: 'done', streaming: false },
    ];
    const items = buildRenderItems(entries, [10, 11, 12, 13, 14, 15]);
    expect(items.map((i) => i.kind)).toEqual([
      'system',
      'tool_call',
      'permission',
      'internal',
      'unknown',
      'bubble',
    ]);
    // Keys derive from the provided ids.
    expect(items[0]?.key).toBe('e10');
    expect(items[5]?.key).toBe('e15');
    // The system badge is carried through.
    expect(items[0]).toMatchObject({ badge: 'green' });
  });

  it('falls back to the index for keys when ids are omitted', () => {
    const entries: ParsedEntry[] = [{ kind: 'unknown', typeLabel: 'x' }];
    const items = buildRenderItems(entries);
    expect(items[0]?.key).toBe('e0');
  });
});
