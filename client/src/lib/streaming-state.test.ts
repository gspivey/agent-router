import { describe, it, expect } from 'vitest';
import {
  shouldShowCursor,
  finishedToolCallIds,
  shouldShowSpinner,
} from './streaming-state.js';
import type { StreamEntry } from './types.js';

/**
 * Pure streaming-state tests (spa-overhaul Task 6 / ROADMAP 76).
 *
 * Covers the cursor-visibility rule (Req 7.2 / HIGH-5) and the tool-call
 * finished/spinner rule (Req 7.3 / HIGH-C), both over the RAW `StreamEntry[]`.
 */

function chunk(text: string): StreamEntry {
  return {
    ts: '2026-01-01T00:00:00Z',
    source: 'agent',
    type: 'session/update',
    update: { sessionUpdate: 'agent_message_chunk', content: { text } },
  };
}

function router(type: string, extra: Record<string, unknown> = {}): StreamEntry {
  return { ts: '2026-01-01T00:00:00Z', source: 'router', type, ...extra };
}

function toolCall(toolCallId: string, title = 'run'): StreamEntry {
  return {
    ts: '2026-01-01T00:00:00Z',
    source: 'agent',
    type: 'session/update',
    update: { sessionUpdate: 'tool_call', toolCallId, title },
  };
}

function toolUpdate(toolCallId: string, status?: string): StreamEntry {
  const update: Record<string, unknown> = {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    content: [{ content: { text: 'out' } }],
  };
  if (status !== undefined) update.status = status;
  return { ts: '2026-01-01T00:00:00Z', source: 'agent', type: 'session/update', update };
}

describe('shouldShowCursor (Req 7.2)', () => {
  it('is false for a non-active session regardless of content', () => {
    const entries = [chunk('Hello')];
    expect(shouldShowCursor(entries, 'completed')).toBe(false);
    expect(shouldShowCursor(entries, 'abandoned')).toBe(false);
    expect(shouldShowCursor(entries, 'failed')).toBe(false);
  });

  it('is false when there is no agent chunk yet', () => {
    expect(shouldShowCursor([router('session_started')], 'active')).toBe(false);
    expect(shouldShowCursor([], 'active')).toBe(false);
  });

  it('is true while active and a chunk streams with no turn-complete marker after it', () => {
    expect(shouldShowCursor([chunk('Hi '), chunk('there')], 'active')).toBe(true);
  });

  it('is false once a session_verified marker follows the last chunk', () => {
    const entries = [chunk('done'), router('session_verified', { termination_reason: 'merged' })];
    expect(shouldShowCursor(entries, 'active')).toBe(false);
  });

  it('is false once a prompt_injected marker follows the last chunk', () => {
    const entries = [chunk('done'), router('prompt_injected', { prompt_source: 'web' })];
    expect(shouldShowCursor(entries, 'active')).toBe(false);
  });

  it('is false once a session_ended marker follows the last chunk', () => {
    const entries = [chunk('done'), router('session_ended', { reason: 'ended' })];
    expect(shouldShowCursor(entries, 'active')).toBe(false);
  });

  it('shows again when a new chunk arrives after a prior turn-complete marker', () => {
    const entries = [
      chunk('turn 1'),
      router('prompt_injected', { prompt_source: 'web' }),
      chunk('turn 2'),
    ];
    expect(shouldShowCursor(entries, 'active')).toBe(true);
  });

  it('ignores a non-router entry with a turn-complete-looking type', () => {
    // Only a router-source marker closes the turn; an agent entry does not.
    const entries = [chunk('typing'), { ts: 't', source: 'agent', type: 'session_verified' } as StreamEntry];
    expect(shouldShowCursor(entries, 'active')).toBe(true);
  });
});

describe('finishedToolCallIds + shouldShowSpinner (Req 7.3)', () => {
  it('a tool call with no finishing update is unfinished', () => {
    const entries = [toolCall('tc1'), toolUpdate('tc1')]; // no status
    const finished = finishedToolCallIds(entries);
    expect(finished.has('tc1')).toBe(false);
  });

  it('marks a tool call finished on a completed status', () => {
    const entries = [toolCall('tc1'), toolUpdate('tc1', 'completed')];
    expect(finishedToolCallIds(entries).has('tc1')).toBe(true);
  });

  it('marks a tool call finished on a failed status', () => {
    const entries = [toolCall('tc1'), toolUpdate('tc1', 'failed')];
    expect(finishedToolCallIds(entries).has('tc1')).toBe(true);
  });

  it('does not finish on an in-progress status', () => {
    const entries = [toolCall('tc1'), toolUpdate('tc1', 'in_progress')];
    expect(finishedToolCallIds(entries).has('tc1')).toBe(false);
  });

  it('spinner shows only when active AND unfinished', () => {
    const finished = new Set<string>(['done1']);
    expect(shouldShowSpinner('running1', finished, 'active')).toBe(true);
    expect(shouldShowSpinner('done1', finished, 'active')).toBe(false);
    // Inactive session → never spin, even if unfinished.
    expect(shouldShowSpinner('running1', finished, 'completed')).toBe(false);
  });

  it('a synthetic (null-id) card never appears in the finished set, so it spins while active', () => {
    const entries = [toolCall('tc1'), toolUpdate('tc1', 'completed')];
    const finished = finishedToolCallIds(entries);
    expect(shouldShowSpinner('__synthetic_0', finished, 'active')).toBe(true);
    expect(shouldShowSpinner('__synthetic_0', finished, 'completed')).toBe(false);
  });
});
