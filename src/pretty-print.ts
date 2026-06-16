/**
 * Pretty-print formatting for stream log entries in the CLI tail view.
 *
 * Extracted as a pure function so it can be unit-tested directly.
 */

// ANSI color constants
const GRAY = '\x1b[90m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export interface StreamEntryLike {
  ts?: string;
  source?: string;
  type?: string;
  [key: string]: unknown;
}

export function prettyPrint(entry: StreamEntryLike): string {
  const ts = entry.ts ?? '';
  const source = entry.source ?? '';
  const type = entry.type ?? '';

  // Router events → gray
  if (source === 'router') {
    return `${GRAY}[${ts}] router/${type}${RESET}`;
  }

  // Errors → red
  if (type === 'stderr' || type === 'error') {
    const content = typeof entry['content'] === 'string' ? ` ${entry['content']}` : '';
    return `${RED}[${ts}] ${source}/${type}${content}${RESET}`;
  }

  // Tool calls → cyan
  if (type === 'tool_call' || type === 'tool_result' || type === 'mcp_call') {
    const tool = typeof entry['tool'] === 'string' ? ` ${entry['tool']}` : '';
    return `${CYAN}[${ts}] ${source}/${type}${tool}${RESET}`;
  }

  // Agent messages and all other types — prefer content over message
  const text = typeof entry['content'] === 'string'
    ? ` ${entry['content']}`
    : typeof entry['message'] === 'string'
      ? ` ${entry['message']}`
      : '';
  return `[${ts}] ${source}/${type}${text}`;
}
