import { describe, it, expect } from 'vitest';
import { prettyPrint } from '../../src/pretty-print.js';

describe('prettyPrint', () => {
  describe('agent message entries', () => {
    it('renders content field for agent-message entries', () => {
      const entry = {
        ts: '2026-06-16T09:00:00Z',
        source: 'agent',
        type: 'agent-message',
        content: 'Here is the fix for your bug.',
        message: 'fallback message',
      };
      const result = prettyPrint(entry);
      expect(result).toContain('Here is the fix for your bug.');
      expect(result).not.toContain('fallback message');
    });

    it('falls back to message when content is absent', () => {
      const entry = {
        ts: '2026-06-16T09:00:00Z',
        source: 'agent',
        type: 'agent-message',
        message: 'fallback text',
      };
      const result = prettyPrint(entry);
      expect(result).toContain('fallback text');
    });

    it('renders empty text when neither content nor message is present', () => {
      const entry = {
        ts: '2026-06-16T09:00:00Z',
        source: 'agent',
        type: 'agent-message',
      };
      const result = prettyPrint(entry);
      expect(result).toBe('[2026-06-16T09:00:00Z] agent/agent-message');
    });
  });

  describe('error entries', () => {
    it('renders content field in red for error type', () => {
      const entry = {
        ts: '2026-06-16T09:01:00Z',
        source: 'agent',
        type: 'error',
        content: 'Something went wrong',
      };
      const result = prettyPrint(entry);
      expect(result).toContain('Something went wrong');
      expect(result).toContain('\x1b[31m'); // RED
    });

    it('renders content field in red for stderr type', () => {
      const entry = {
        ts: '2026-06-16T09:01:00Z',
        source: 'agent',
        type: 'stderr',
        content: 'Error output line',
      };
      const result = prettyPrint(entry);
      expect(result).toContain('Error output line');
      expect(result).toContain('\x1b[31m');
    });

    it('renders without content when content is missing', () => {
      const entry = {
        ts: '2026-06-16T09:01:00Z',
        source: 'agent',
        type: 'error',
      };
      const result = prettyPrint(entry);
      expect(result).toContain('agent/error');
      expect(result).toContain('\x1b[31m');
    });
  });

  describe('tool call entries', () => {
    it('renders tool name in cyan for tool_call', () => {
      const entry = {
        ts: '2026-06-16T09:02:00Z',
        source: 'agent',
        type: 'tool_call',
        tool: 'read_file',
      };
      const result = prettyPrint(entry);
      expect(result).toContain('read_file');
      expect(result).toContain('\x1b[36m'); // CYAN
    });

    it('renders tool name in cyan for tool_result', () => {
      const entry = {
        ts: '2026-06-16T09:02:00Z',
        source: 'agent',
        type: 'tool_result',
        tool: 'write_file',
      };
      const result = prettyPrint(entry);
      expect(result).toContain('write_file');
      expect(result).toContain('\x1b[36m');
    });

    it('renders tool name in cyan for mcp_call', () => {
      const entry = {
        ts: '2026-06-16T09:02:00Z',
        source: 'agent',
        type: 'mcp_call',
        tool: 'register_pr',
      };
      const result = prettyPrint(entry);
      expect(result).toContain('register_pr');
      expect(result).toContain('\x1b[36m');
    });

    it('renders without tool name when tool is missing', () => {
      const entry = {
        ts: '2026-06-16T09:02:00Z',
        source: 'agent',
        type: 'tool_call',
      };
      const result = prettyPrint(entry);
      expect(result).toContain('agent/tool_call');
      expect(result).not.toContain('undefined');
    });
  });

  describe('router entries', () => {
    it('renders router events in gray', () => {
      const entry = {
        ts: '2026-06-16T09:03:00Z',
        source: 'router',
        type: 'session_started',
      };
      const result = prettyPrint(entry);
      expect(result).toContain('router/session_started');
      expect(result).toContain('\x1b[90m'); // GRAY
    });
  });
});

// ---------------------------------------------------------------------------
// Task 21.10 — Additional edge-case pretty-print tests
// ---------------------------------------------------------------------------

describe('prettyPrint edge cases (task 21.10)', () => {
  it('router source entries begin with the ANSI gray escape sequence', () => {
    const entry = {
      ts: '2026-11-03T00:00:00Z',
      source: 'router',
      type: 'session_started',
    };
    const result = prettyPrint(entry);
    // Must start with the gray ANSI escape (not plain text)
    expect(result.startsWith('\x1b[90m')).toBe(true);
  });

  it('non-standard entry type falls through to the plain-text path', () => {
    const entry = {
      ts: '2026-11-03T00:00:00Z',
      source: 'agent',
      type: 'unknown_custom_type',
      message: 'custom text',
    };
    const result = prettyPrint(entry);
    // Plain text path: no error-red or cyan tool coloring
    expect(result).not.toContain('\x1b[31m'); // no RED
    expect(result).not.toContain('\x1b[36m'); // no CYAN
    // Contains the message text
    expect(result).toContain('custom text');
  });

  it('missing ts, source, and type fall back to empty strings', () => {
    const entry = {};
    const result = prettyPrint(entry);
    // Does not throw, returns the bracket prefix at minimum
    expect(typeof result).toBe('string');
    expect(result).toContain('['); // contains timestamp bracket
  });
});
