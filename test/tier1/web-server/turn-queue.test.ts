import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createTurnQueue } from '../../../src/turn-queue.js';
import type { ACPClient } from '../../../src/acp.js';
import type { SessionFiles, PromptSource } from '../../../src/session-files.js';
import type { Logger } from '../../../src/log.js';

function createFakeACP(options?: { delay?: number; failAt?: number }): ACPClient & { calls: string[] } {
  const calls: string[] = [];
  let callCount = 0;
  return {
    calls,
    initialize: () => Promise.resolve(),
    newSession: () => Promise.resolve('fake-session'),
    newSessionWithPrompt: () => Promise.resolve('fake-session'),
    loadSession: () => Promise.resolve(),
    async sendPrompt(prompt: string): Promise<void> {
      callCount++;
      if (options?.failAt === callCount) {
        throw new Error('ACP send failed');
      }
      if (options?.delay) {
        await new Promise((r) => setTimeout(r, options.delay));
      }
      calls.push(prompt);
    },
    cancel: () => {},
    notifications: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
    sessionEnded: new Promise(() => {}),
    close: () => Promise.resolve(),
    kill: () => Promise.resolve(),
  };
}

function createFakeSessionFiles(): SessionFiles & { streams: unknown[]; prompts: Array<{ source: PromptSource; prompt: string }> } {
  const streams: unknown[] = [];
  const prompts: Array<{ source: PromptSource; prompt: string }> = [];
  return {
    streams,
    prompts,
    createSession: () => ({ dir: '', meta: '', stream: '', prompts: '' }),
    appendStream: (_id: string, entry: unknown) => { streams.push(entry); },
    appendPrompt: (_id: string, source: PromptSource, prompt: string) => { prompts.push({ source, prompt }); },
    updateMeta: () => {},
    readMeta: () => ({ session_id: '', original_prompt: '', status: 'active', created_at: 0, completed_at: null, prs: [] }),
    listSessions: () => [],
    sessionExists: () => true,
  };
}

function createFakeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createFakeLogger(),
  };
}

describe('TurnQueue', () => {
  describe('Property 24: Turn Queue Serialization', () => {
    it('at most one sendPrompt is in-flight at a time with concurrent enqueues', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 2, maxLength: 10 }),
          async (prompts) => {
            let inFlight = 0;
            let maxInFlight = 0;

            const acp = createFakeACP();
            const originalSendPrompt = acp.sendPrompt.bind(acp);
            acp.sendPrompt = async (prompt: string): Promise<void> => {
              inFlight++;
              maxInFlight = Math.max(maxInFlight, inFlight);
              await originalSendPrompt(prompt);
              // Simulate async work
              await new Promise((r) => setTimeout(r, 1));
              inFlight--;
            };

            const sf = createFakeSessionFiles();
            const log = createFakeLogger();
            const queue = createTurnQueue(acp, sf, 'test-session', log);

            // Enqueue all prompts concurrently
            const allDone = Promise.all(
              prompts.map((p) => queue.enqueue(p, 'web'))
            );

            await allDone;

            expect(maxInFlight).toBe(1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('FIFO ordering is preserved', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 2, maxLength: 10 }),
          async (prompts) => {
            const acp = createFakeACP({ delay: 1 });
            const sf = createFakeSessionFiles();
            const log = createFakeLogger();
            const queue = createTurnQueue(acp, sf, 'test-session', log);

            // Enqueue all concurrently
            await Promise.all(prompts.map((p) => queue.enqueue(p, 'web')));

            // Verify order
            expect(acp.calls).toEqual(prompts);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  it('pending() tracks queued items correctly', async () => {
    let resolveFirst: (() => void) | undefined;
    const acp = createFakeACP();
    acp.sendPrompt = () => new Promise<void>((r) => { resolveFirst = r; });

    const sf = createFakeSessionFiles();
    const log = createFakeLogger();
    const queue = createTurnQueue(acp, sf, 'test-session', log);

    // First enqueue starts processing (blocks in sendPrompt)
    const p1 = queue.enqueue('first', 'cli');
    await new Promise((r) => setTimeout(r, 10));

    // Second and third are pending
    const p2 = queue.enqueue('second', 'web');
    const p3 = queue.enqueue('third', 'webhook');

    expect(queue.pending()).toBe(2);

    // Resolve first, then switch to non-blocking sendPrompt for remaining
    acp.sendPrompt = () => Promise.resolve();
    resolveFirst!();
    await p1;
    await p2;
    await p3;
  });

  it('drain() rejects pending and waits for in-flight', async () => {
    let resolveInFlight: (() => void) | undefined;
    const acp = createFakeACP();
    let callCount = 0;
    acp.sendPrompt = () => {
      callCount++;
      if (callCount === 1) {
        return new Promise<void>((r) => { resolveInFlight = r; });
      }
      return Promise.resolve();
    };

    const sf = createFakeSessionFiles();
    const log = createFakeLogger();
    const queue = createTurnQueue(acp, sf, 'test-session', log);

    // First enqueue starts processing (blocks)
    const p1 = queue.enqueue('first', 'cli');
    await new Promise((r) => setTimeout(r, 5));

    // Second is pending
    const p2 = queue.enqueue('second', 'web');

    // Drain: second should reject, wait for first
    const drainPromise = queue.drain();

    // p2 should reject
    await expect(p2).rejects.toThrow();

    // Drain hasn't resolved yet (first still in-flight)
    let drainDone = false;
    drainPromise.then(() => { drainDone = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(drainDone).toBe(false);

    // Resolve in-flight
    resolveInFlight!();
    await p1;
    await drainPromise;
  });

  it('enqueue after drain rejects immediately', async () => {
    const acp = createFakeACP();
    const sf = createFakeSessionFiles();
    const log = createFakeLogger();
    const queue = createTurnQueue(acp, sf, 'test-session', log);

    await queue.drain();
    await expect(queue.enqueue('late', 'web')).rejects.toThrow('Session draining');
  });

  it('logs prompt_injection_failed on sendPrompt failure', async () => {
    const acp = createFakeACP({ failAt: 1 });
    const sf = createFakeSessionFiles();
    const log = createFakeLogger();
    const queue = createTurnQueue(acp, sf, 'test-session', log);

    // The enqueue promise resolves (fire-and-forget semantics) but the
    // failure is logged to stream
    await queue.enqueue('fail-prompt', 'web').catch(() => {});

    const failEntry = sf.streams.find(
      (e) => (e as Record<string, unknown>).type === 'prompt_injection_failed'
    );
    expect(failEntry).toBeDefined();
    expect((failEntry as Record<string, unknown>).prompt_source).toBe('web');
    expect((failEntry as Record<string, unknown>).error).toBe('ACP send failed');
  });
});
