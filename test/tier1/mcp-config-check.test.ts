/**
 * Tier 1 tests: warnOnConflictingMcpConfig startup check.
 *
 * Spec: .kiro/specs/mcp-server-wiring/ · task 7b
 * Requirements: 10.1, 10.2
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { warnOnConflictingMcpConfig } from '../../src/mcp-config-check.js';
import { createLogger, type Logger } from '../../src/log.js';

let homeDir: string;
let lines: string[];
let log: Logger;

function writeMcpConfig(contents: string): void {
  const dir = path.join(homeDir, '.kiro', 'settings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp.json'), contents);
}

function warningLines(): string[] {
  return lines.filter((l) => l.includes('"level":"warn"'));
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-check-'));
  lines = [];
  log = createLogger({ level: 'debug', output: (line: string) => { lines.push(line); } });
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('warnOnConflictingMcpConfig', () => {
  it('does not warn when the config file is absent', () => {
    warnOnConflictingMcpConfig(homeDir, log);
    expect(warningLines()).toHaveLength(0);
  });

  it('warns when the config contains an agent-router key', () => {
    writeMcpConfig(
      JSON.stringify({
        mcpServers: {
          'agent-router': { command: 'npx', args: ['tsx', '/x/mcp-server.ts'] },
        },
      }),
    );
    warnOnConflictingMcpConfig(homeDir, log);
    const warns = warningLines();
    expect(warns).toHaveLength(1);
    expect(warns[0]!).toContain('agent-router');
  });

  it('does not warn when the config has mcpServers but no agent-router key', () => {
    writeMcpConfig(
      JSON.stringify({
        mcpServers: {
          'some-other-server': { command: 'node', args: [] },
        },
      }),
    );
    warnOnConflictingMcpConfig(homeDir, log);
    expect(warningLines()).toHaveLength(0);
  });

  it('does not throw on malformed JSON', () => {
    writeMcpConfig('{ not valid json');
    expect(() => warnOnConflictingMcpConfig(homeDir, log)).not.toThrow();
    expect(warningLines()).toHaveLength(0);
  });
});
