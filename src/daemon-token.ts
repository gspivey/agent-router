/**
 * Daemon hook token store.
 *
 * Generated on every daemon start, written to `$rootDir/daemon-token` with
 * mode 0600. Adapters (or hand-installed hooks) read the file at fire time
 * to obtain the current token; the daemon itself reads from memory.
 *
 * Restarts naturally invalidate stale hooks — no persistent secret survives
 * across daemon lifetimes.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './log.js';

export interface DaemonTokenStore {
  /** Returns the current in-memory token (cheap; no file I/O). */
  read(): string;
  /** Generate a new token, write it to disk, update the cache, return it. */
  rotate(): string;
  /** Absolute path to the on-disk token file. */
  filePath(): string;
}

export function createDaemonTokenStore(deps: {
  rootDir: string;
  log: Logger;
}): DaemonTokenStore {
  const { rootDir, log } = deps;
  const filePath = path.join(rootDir, 'daemon-token');

  function generate(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  function writeAtomic(value: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, value);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  }

  let cached: string = generate();
  writeAtomic(cached);
  log.info('Daemon hook token written', { path: filePath });

  return {
    read(): string {
      return cached;
    },
    rotate(): string {
      cached = generate();
      writeAtomic(cached);
      log.info('Daemon hook token rotated', { path: filePath });
      return cached;
    },
    filePath(): string {
      return filePath;
    },
  };
}
