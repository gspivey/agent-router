/**
 * Agent process isolation — daemon startup checks (item 86, tasks 86.1).
 *
 * Spec: .kiro/specs/agent-process-isolation/ · tasks 86.1
 *
 * Two advisory, non-fatal checks run at daemon startup regardless of the
 * `useWorkerUid` setting:
 *
 *   - `checkTokenFilePermissions` (FR-3.2) verifies that the daemon's secret
 *     files (`tokens.json`, `daemon-token`, `config.json`) are not readable by
 *     group or other. It inspects `mode & 0o044` and logs a WARNING if any of
 *     those bits are set. It never throws — a loose permission is an operator
 *     hygiene problem, not a reason to refuse to boot.
 *
 *   - `checkIptablesRules` (FR-7.4 / AC-7) reads the on-disk iptables restore
 *     file written by `scripts/setup-agent-user.sh` and looks for the
 *     `AGENTWORKER_OUT` chain name. It uses `fs.readFileSync` only — no
 *     `execSync`, no `CAP_NET_ADMIN` — so it is safe to run unprivileged. A
 *     missing or unreadable file (the common case when the isolation substrate
 *     was never installed) logs a WARNING and returns; it does not throw.
 *
 * Both functions take an injectable filesystem reader so they can be unit
 * tested without touching the real filesystem.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './log.js';

/** The daemon-owned secret files that must not be group/other readable. */
const SECRET_FILES = ['tokens.json', 'daemon-token', 'config.json'] as const;

/** Bits that mean "readable by group or other". */
const GROUP_OTHER_READ = 0o044;

/** The on-disk iptables restore file written by the setup script. */
export const IPTABLES_RULES_PATH = '/etc/iptables/agent-router-rules.v4';

/** The chain name the setup script installs for the agentworker uid. */
const AGENTWORKER_CHAIN = 'AGENTWORKER_OUT';

/** Minimal fs surface used by the checks, injectable for tests. */
export interface IsolationFsReader {
  statSync: (p: string) => { mode: number };
  readFileSync: (p: string, enc: 'utf-8') => string;
  existsSync: (p: string) => boolean;
}

const defaultReader: IsolationFsReader = {
  statSync: (p) => fs.statSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  existsSync: (p) => fs.existsSync(p),
};

/**
 * FR-3.2: warn when a daemon secret file is group/other-readable.
 *
 * Checks `tokens.json`, `daemon-token`, and `config.json` under `rootDir`.
 * Files that do not exist are skipped silently (a fresh install may not have
 * created `tokens.json` yet). Never throws.
 */
export function checkTokenFilePermissions(
  rootDir: string,
  log: Logger,
  reader: IsolationFsReader = defaultReader,
): void {
  for (const name of SECRET_FILES) {
    const filePath = path.join(rootDir, name);
    try {
      if (!reader.existsSync(filePath)) continue;
      const mode = reader.statSync(filePath).mode;
      const looseBits = mode & GROUP_OTHER_READ;
      if (looseBits !== 0) {
        log.warn('Secret file is group/other-readable — tighten permissions', {
          file: filePath,
          // Octal rendering of the permission bits for the operator.
          mode: (mode & 0o777).toString(8).padStart(3, '0'),
          hint: `chmod 600 ${filePath}`,
        });
      }
    } catch (err: unknown) {
      // A stat failure is advisory only — do not crash the daemon.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('Could not check secret file permissions', { file: filePath, error: msg });
    }
  }
}

/**
 * FR-7.4 / AC-7: warn when the agentworker iptables rules are not on disk.
 *
 * Reads `/etc/iptables/agent-router-rules.v4` and checks for the
 * `AGENTWORKER_OUT` chain name. Logs a WARNING if the file is absent,
 * unreadable, or does not mention the chain. Never throws. This checks the
 * on-disk config only; the systemd unit `agent-router-iptables.service` is
 * what actually loads the rules at boot.
 */
export function checkIptablesRules(
  log: Logger,
  reader: IsolationFsReader = defaultReader,
  rulesPath: string = IPTABLES_RULES_PATH,
): void {
  let contents: string;
  try {
    contents = reader.readFileSync(rulesPath, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('iptables rules file not readable — agentworker egress may be unfiltered', {
      file: rulesPath,
      error: msg,
    });
    return;
  }

  if (!contents.includes(AGENTWORKER_CHAIN)) {
    log.warn('iptables rules file does not contain the agentworker chain — egress may be unfiltered', {
      file: rulesPath,
      expected_chain: AGENTWORKER_CHAIN,
    });
  }
}
