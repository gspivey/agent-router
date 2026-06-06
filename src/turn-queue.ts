import type { ACPClient } from './acp.js';
import type { SessionFiles, PromptSource } from './session-files.js';
import type { Logger } from './log.js';

export interface TurnQueue {
  enqueue(prompt: string, source: PromptSource, actor?: string): Promise<void>;
  pending(): number;
  /** Returns true when a sendPrompt call is currently in-flight. */
  busy(): boolean;
  drain(): Promise<void>;
}

export function createTurnQueue(
  acp: ACPClient,
  sessionFiles: SessionFiles,
  sessionId: string,
  log: Logger,
): TurnQueue {
  let current: Promise<void> = Promise.resolve();
  let pendingCount = 0;
  let drained = false;
  let inFlight = false;
  const pendingRejects: Array<(err: Error) => void> = [];

  return {
    enqueue(prompt: string, source: PromptSource, actor?: string): Promise<void> {
      if (drained) return Promise.reject(new Error('Session draining'));
      pendingCount++;

      return new Promise<void>((resolve, reject) => {
        pendingRejects.push(reject);
        const prev = current;
        current = prev.then(async () => {
          // Remove from pending rejects array (we're now executing)
          const idx = pendingRejects.indexOf(reject);
          if (idx !== -1) pendingRejects.splice(idx, 1);
          pendingCount--;

          if (drained) {
            reject(new Error('Session draining'));
            return;
          }

          try {
            inFlight = true;
            await acp.sendPrompt(prompt);
            inFlight = false;
            sessionFiles.appendPrompt(sessionId, source, prompt);
            sessionFiles.appendStream(sessionId, {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'prompt_injected',
              prompt_source: source,
              ...(actor ? { actor } : {}),
            });
            resolve();
          } catch (err: unknown) {
            inFlight = false;
            const errorMsg = err instanceof Error ? err.message : String(err);
            sessionFiles.appendStream(sessionId, {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'prompt_injection_failed',
              prompt_source: source,
              ...(actor ? { actor } : {}),
              error: errorMsg,
            });
            log.error('Prompt delivery failed', { sessionId, source, error: errorMsg });
            reject(err);
          }
        });
      });
    },

    pending(): number {
      return pendingCount;
    },

    busy(): boolean {
      return inFlight;
    },

    async drain(): Promise<void> {
      drained = true;
      // Reject all pending
      for (const rej of pendingRejects) {
        rej(new Error('Session draining'));
      }
      pendingRejects.length = 0;
      // Wait for in-flight to complete
      await current;
    },
  };
}
