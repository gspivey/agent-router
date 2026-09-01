import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseStreamEntry } from '../../../src/ui/logic.js';
import type { ParsedEntry } from '../../../src/ui/logic.js';

describe('parseStreamEntry', () => {
  describe('router system events', () => {
    it('maps session_started to a system pill', () => {
      const parsed = parseStreamEntry({
        ts: '2026-01-01T00:00:00Z',
        source: 'router',
        type: 'session_started',
        original_prompt: 'do the thing',
      });
      expect(parsed.kind).toBe('system');
      if (parsed.kind === 'system') {
        expect(parsed.subtype).toBe('session_started');
        expect(parsed.text).toContain('Session started');
        expect(parsed.badge).toBeUndefined();
      }
    });

    it('maps prompt_injected including the prompt_source', () => {
      const parsed = parseStreamEntry({
        source: 'router',
        type: 'prompt_injected',
        prompt_source: 'webhook',
      });
      expect(parsed).toEqual<ParsedEntry>({
        kind: 'system',
        subtype: 'prompt_injected',
        text: 'Prompt injected (webhook)',
      });
    });

    it('maps session_ended including the reason', () => {
      const parsed = parseStreamEntry({
        source: 'router',
        type: 'session_ended',
        reason: 'merged',
      });
      expect(parsed).toMatchObject({
        kind: 'system',
        subtype: 'session_ended',
        text: 'Session ended — merged',
      });
    });

    it('maps session_verified to a green badge', () => {
      const parsed = parseStreamEntry({
        source: 'router',
        type: 'session_verified',
        termination_reason: 'merged',
        prs: [{ repo: 'o/r', pr_number: 1 }],
      });
      expect(parsed.kind).toBe('system');
      if (parsed.kind === 'system') {
        expect(parsed.subtype).toBe('session_verified');
        expect(parsed.badge).toBe('green');
        expect(parsed.text).toContain('merged');
      }
    });

    it('maps verification_failed to a red badge including the error', () => {
      const parsed = parseStreamEntry({
        source: 'router',
        type: 'verification_failed',
        error: 'no PR found',
      });
      expect(parsed.kind).toBe('system');
      if (parsed.kind === 'system') {
        expect(parsed.subtype).toBe('verification_failed');
        expect(parsed.badge).toBe('red');
        expect(parsed.text).toContain('no PR found');
      }
    });

    it('maps web_inject and web_interrupt to system pills', () => {
      const inject = parseStreamEntry({ source: 'router', type: 'web_inject' });
      const interrupt = parseStreamEntry({ source: 'router', type: 'web_interrupt' });
      expect(inject).toMatchObject({ kind: 'system', subtype: 'web_inject' });
      expect(interrupt).toMatchObject({ kind: 'system', subtype: 'web_interrupt' });
    });

    it('treats an unrecognized router type as unknown', () => {
      const parsed = parseStreamEntry({ source: 'router', type: 'mystery_event' });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'unknown', typeLabel: 'mystery_event' });
    });
  });

  describe('agent session/update stream', () => {
    it('maps agent_message_chunk to a streaming agent_chunk', () => {
      const parsed = parseStreamEntry({
        source: 'agent',
        type: 'session/update',
        update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hello ' } },
      });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'agent_chunk', text: 'hello ', streaming: true });
    });

    it('maps tool_call with a toolCallId and title', () => {
      const parsed = parseStreamEntry({
        source: 'agent',
        type: 'session/update',
        update: { sessionUpdate: 'tool_call', toolCallId: 'abc', title: 'Run tests' },
      });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'tool_call', toolCallId: 'abc', title: 'Run tests' });
    });

    it('maps tool_call_update concatenating content fragments', () => {
      const parsed = parseStreamEntry({
        source: 'agent',
        type: 'session/update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'abc',
          content: [{ content: { text: 'line1\n' } }, { content: { text: 'line2' } }],
        },
      });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'tool_update', toolCallId: 'abc', text: 'line1\nline2' });
    });

    it('tolerates a tool_call_update with a missing toolCallId (empty string)', () => {
      const parsed = parseStreamEntry({
        source: 'agent',
        type: 'session/update',
        update: { sessionUpdate: 'tool_call_update', content: [{ content: { text: 'x' } }] },
      });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'tool_update', toolCallId: '', text: 'x' });
    });

    it('emits toolCallId null for a session/update tool_call without an id', () => {
      const parsed = parseStreamEntry({
        source: 'agent',
        type: 'session/update',
        update: { sessionUpdate: 'tool_call', title: 'ls' },
      });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'tool_call', toolCallId: null, title: 'ls' });
    });

    it('maps an unrecognized sessionUpdate sub-type to unknown', () => {
      const parsed = parseStreamEntry({
        source: 'agent',
        type: 'session/update',
        update: { sessionUpdate: 'plan' },
      });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'unknown', typeLabel: 'session/update' });
    });
  });

  describe('permission requests', () => {
    it('maps session/request_permission to a permission card', () => {
      const parsed = parseStreamEntry({
        source: 'agent',
        type: 'session/request_permission',
        toolCall: { title: 'Delete file' },
        options: [{ optionId: 'allow' }],
      });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'permission', title: 'Delete file' });
    });
  });

  describe('kiro internal events', () => {
    it('maps _kiro.dev/metadata to an internal entry preserving the subtype', () => {
      const parsed = parseStreamEntry({
        source: 'agent',
        type: '_kiro.dev/metadata',
        content: 'context 42%',
      });
      expect(parsed).toEqual<ParsedEntry>({
        kind: 'internal',
        subtype: '_kiro.dev/metadata',
        text: 'context 42%',
      });
    });

    it('maps other _kiro.dev/* events to internal', () => {
      const parsed = parseStreamEntry({
        source: 'agent',
        type: '_kiro.dev/mcp/server_initialized',
      });
      expect(parsed).toMatchObject({ kind: 'internal', subtype: '_kiro.dev/mcp/server_initialized' });
    });
  });

  describe('legacy flat fallbacks', () => {
    it('maps legacy agent_message (top-level content) to a non-streaming bubble', () => {
      const parsed = parseStreamEntry({ source: 'agent', type: 'agent_message', content: 'msg-1' });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'agent_message', text: 'msg-1', streaming: false });
    });

    it('maps a bare legacy tool_call to tool_call with toolCallId null', () => {
      const parsed = parseStreamEntry({ source: 'agent', type: 'tool_call' });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'tool_call', toolCallId: null, title: '' });
    });

    it('preserves a toolCallId on a legacy tool_call when present', () => {
      const parsed = parseStreamEntry({ source: 'agent', type: 'tool_call', toolCallId: 'legacy1', title: 'grep' });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'tool_call', toolCallId: 'legacy1', title: 'grep' });
    });
  });

  describe('unknown / malformed shapes', () => {
    it('maps an unrecognized agent type to unknown with its type label', () => {
      const parsed = parseStreamEntry({ source: 'agent', type: 'weird_thing' });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'unknown', typeLabel: 'weird_thing' });
    });

    it('maps an entry with no type to unknown labelled "unknown"', () => {
      const parsed = parseStreamEntry({ source: 'agent' });
      expect(parsed).toEqual<ParsedEntry>({ kind: 'unknown', typeLabel: 'unknown' });
    });

    it('never throws and never leaks raw JSON for arbitrary values', () => {
      const inputs: unknown[] = [null, undefined, 42, 'a string', [], {}, { type: 123 }, { source: 'other', type: 'x' }];
      for (const input of inputs) {
        const parsed = parseStreamEntry(input);
        expect(parsed.kind).toBe('unknown');
        if (parsed.kind === 'unknown') {
          // typeLabel is only ever the entry's `type` field or the literal 'unknown';
          // it must never be a stringification of the raw entry.
          expect(parsed.typeLabel).not.toContain('{');
          expect(parsed.typeLabel).not.toContain('source');
        }
      }
    });

    it('does not throw on any arbitrary object (property)', () => {
      fc.assert(
        fc.property(fc.object(), (obj) => {
          expect(() => parseStreamEntry(obj)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('agent_message_chunk reassembly (property)', () => {
    it('concatenating parsed chunk text equals the raw concatenation of inputs', () => {
      fc.assert(
        fc.property(fc.array(fc.string(), { minLength: 1, maxLength: 30 }), (fragments) => {
          // Build a run of agent_message_chunk stream entries.
          const entries = fragments.map((text) => ({
            source: 'agent',
            type: 'session/update',
            update: { sessionUpdate: 'agent_message_chunk', content: { text } },
          }));

          // Parse each and apply the reassembly rule: join agent_chunk text in
          // stream order with no separators.
          let reassembled = '';
          for (const e of entries) {
            const parsed = parseStreamEntry(e);
            expect(parsed.kind).toBe('agent_chunk');
            if (parsed.kind === 'agent_chunk') {
              expect(parsed.streaming).toBe(true);
              reassembled += parsed.text;
            }
          }

          expect(reassembled).toBe(fragments.join(''));
        }),
        { numRuns: 100 },
      );
    });
  });
});
