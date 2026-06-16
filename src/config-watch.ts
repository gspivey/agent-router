import * as fs from 'node:fs';
import { loadConfig } from './config.js';
import type { AgentRouterConfig } from './config.js';

export interface WatchConfigOptions {
  debounceMs?: number;
}

export interface ConfigWatcher {
  close(): void;
}

export function watchConfig(
  configPath: string,
  onReload: (next: AgentRouterConfig) => void,
  onError: (err: Error) => void,
  opts?: WatchConfigOptions,
): ConfigWatcher {
  const debounceMs = opts?.debounceMs ?? 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher = fs.watch(configPath, () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      try {
        const next = loadConfig(configPath);
        onReload(next);
      } catch (err: unknown) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    }, debounceMs);
  });

  return {
    close(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      watcher.close();
    },
  };
}
