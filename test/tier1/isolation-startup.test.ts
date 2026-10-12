/**
 * Tier 1 tests for the agent-process-isolation startup checks
 * (item 86, task 86.1).
 *
 * Spec: .kiro/specs/agent-process-isolation/ · tasks 86.1
 *
 * `checkTokenFilePermissions` (FR-3.2) and `checkIptablesRules` (FR-7.4 / AC-7)
 * are advisory and must never throw. They take an injectable fs reader so these
 * tests run with no real filesystem or privileges.
 */
import { describe, it, expect } from 'vitest';
import {
  checkTokenFilePermissions,
  checkIptablesRules,
  IPTABLES_RULES_PATH,
  type IsolationFsReader,
} from '../../src/isolation-startup.js';
import type { Logger } from '../../src/log.js';

interface LogCall {
  level: 'info' | 'warn' | 'error';
  msg: string;
  ctx?: Record<string, unknown> | undefined;
}

/** Captures log calls so assertions can inspect level + message + context. */
function makeLog(): { log: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const log = {
    info: (msg: string, ctx?: Record<string, unknown>) => calls.push({ level: 'info', msg, ctx }),
    warn: (msg: string, ctx?: Record<string, unknown>) => calls.push({ level: 'warn', msg, ctx }),
    error: (msg: string, ctx?: Record<string, unknown>) => calls.push({ level: 'error', msg, ctx }),
    child: () => log,
  } as unknown as Logger;
  return { log, calls };
}

const ROOT = '/fake/root';

describe('checkTokenFilePermissions (FR-3.2)', () => {
  it('warns when a secret file is group-readable (0o640)', () => {
    const { log, calls } = makeLog();
    const reader: IsolationFsReader = {
      existsSync: (p) => p.endsWith('tokens.json'),
      statSync: () => ({ mode: 0o640 }),
      readFileSync: () => '',
    };
    checkTokenFilePermissions(ROOT, log, reader);
    const warns = calls.filter((c) => c.level === 'warn');
    expect(warns.length).toBe(1);
    expect(warns[0]!.msg).toMatch(/group\/other-readable/);
    expect(warns[0]!.ctx?.['file']).toMatch(/tokens\.json$/);
    expect(warns[0]!.ctx?.['mode']).toBe('640');
  });

  it('warns when a secret file is other-readable (0o604)', () => {
    const { log, calls } = makeLog();
    const reader: IsolationFsReader = {
      existsSync: (p) => p.endsWith('daemon-token'),
      statSync: () => ({ mode: 0o604 }),
      readFileSync: () => '',
    };
    checkTokenFilePermissions(ROOT, log, reader);
    expect(calls.filter((c) => c.level === 'warn').length).toBe(1);
  });

  it('does not warn when all secret files are mode 0o600', () => {
    const { log, calls } = makeLog();
    const reader: IsolationFsReader = {
      existsSync: () => true,
      statSync: () => ({ mode: 0o600 }),
      readFileSync: () => '',
    };
    checkTokenFilePermissions(ROOT, log, reader);
    expect(calls.filter((c) => c.level === 'warn').length).toBe(0);
  });

  it('skips files that do not exist (no warning)', () => {
    const { log, calls } = makeLog();
    const reader: IsolationFsReader = {
      existsSync: () => false,
      statSync: () => {
        throw new Error('should not be called');
      },
      readFileSync: () => '',
    };
    checkTokenFilePermissions(ROOT, log, reader);
    expect(calls.length).toBe(0);
  });

  it('never throws when statSync fails, logs an advisory warning instead', () => {
    const { log, calls } = makeLog();
    const reader: IsolationFsReader = {
      existsSync: () => true,
      statSync: () => {
        throw new Error('EACCES');
      },
      readFileSync: () => '',
    };
    expect(() => checkTokenFilePermissions(ROOT, log, reader)).not.toThrow();
    expect(calls.some((c) => c.level === 'warn')).toBe(true);
  });

  it('checks all three secret files', () => {
    const { log, calls } = makeLog();
    const seen: string[] = [];
    const reader: IsolationFsReader = {
      existsSync: (p) => {
        seen.push(p);
        return false;
      },
      statSync: () => ({ mode: 0o600 }),
      readFileSync: () => '',
    };
    checkTokenFilePermissions(ROOT, log, reader);
    expect(seen.some((p) => p.endsWith('tokens.json'))).toBe(true);
    expect(seen.some((p) => p.endsWith('daemon-token'))).toBe(true);
    expect(seen.some((p) => p.endsWith('config.json'))).toBe(true);
    expect(calls.length).toBe(0);
  });
});

describe('checkIptablesRules (FR-7.4 / AC-7)', () => {
  it('does not warn when the file contains AGENTWORKER_OUT', () => {
    const { log, calls } = makeLog();
    const reader: IsolationFsReader = {
      existsSync: () => true,
      statSync: () => ({ mode: 0o644 }),
      readFileSync: () => '*filter\n:AGENTWORKER_OUT - [0:0]\nCOMMIT\n',
    };
    checkIptablesRules(log, reader);
    expect(calls.filter((c) => c.level === 'warn').length).toBe(0);
  });

  it('warns when the file is unreadable (not installed)', () => {
    const { log, calls } = makeLog();
    const reader: IsolationFsReader = {
      existsSync: () => false,
      statSync: () => ({ mode: 0o644 }),
      readFileSync: () => {
        throw new Error('ENOENT');
      },
    };
    checkIptablesRules(log, reader);
    const warns = calls.filter((c) => c.level === 'warn');
    expect(warns.length).toBe(1);
    expect(warns[0]!.ctx?.['file']).toBe(IPTABLES_RULES_PATH);
  });

  it('warns when the file exists but lacks the agentworker chain', () => {
    const { log, calls } = makeLog();
    const reader: IsolationFsReader = {
      existsSync: () => true,
      statSync: () => ({ mode: 0o644 }),
      readFileSync: () => '*filter\n:INPUT ACCEPT [0:0]\nCOMMIT\n',
    };
    checkIptablesRules(log, reader);
    const warns = calls.filter((c) => c.level === 'warn');
    expect(warns.length).toBe(1);
    expect(warns[0]!.ctx?.['expected_chain']).toBe('AGENTWORKER_OUT');
  });

  it('never throws on a read failure', () => {
    const { log } = makeLog();
    const reader: IsolationFsReader = {
      existsSync: () => true,
      statSync: () => ({ mode: 0o644 }),
      readFileSync: () => {
        throw new Error('EACCES');
      },
    };
    expect(() => checkIptablesRules(log, reader)).not.toThrow();
  });

  it('honors a custom rules path', () => {
    const { log, calls } = makeLog();
    const reader: IsolationFsReader = {
      existsSync: () => true,
      statSync: () => ({ mode: 0o644 }),
      readFileSync: (p) => {
        expect(p).toBe('/custom/rules.v4');
        return 'AGENTWORKER_OUT';
      },
    };
    checkIptablesRules(log, reader, '/custom/rules.v4');
    expect(calls.filter((c) => c.level === 'warn').length).toBe(0);
  });
});
