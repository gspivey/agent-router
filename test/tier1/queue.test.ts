import { describe, it, expect } from 'vitest';
import { createEventQueue, type QueuedEvent } from '../../src/queue.js';

function makeEvent(id: number, overrides?: Partial<QueuedEvent>): QueuedEvent {
  return {
    id,
    repo: 'owner/repo',
    prNumber: 1,
    eventType: 'check_run',
    payload: '{}',
    source: 'webhook',
    ...overrides,
  };
}

describe('createEventQueue', () => {
  it('enqueue increases length', () => {
    const q = createEventQueue();
    expect(q.length).toBe(0);
    q.enqueue(makeEvent(1));
    expect(q.length).toBe(1);
    q.enqueue(makeEvent(2));
    expect(q.length).toBe(2);
  });

  it('events are processed in FIFO order', async () => {
    const q = createEventQueue();
    const processed: number[] = [];

    q.enqueue(makeEvent(1));
    q.enqueue(makeEvent(2));
    q.enqueue(makeEvent(3));

    q.startWorker(async (event) => {
      processed.push(event.id);
    });

    // Give the worker time to drain
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await q.shutdown(1);

    expect(processed).toEqual([1, 2, 3]);
  });

  it('worker processes events sequentially, not concurrently', async () => {
    const q = createEventQueue();
    let concurrent = 0;
    let maxConcurrent = 0;
    const processed: number[] = [];

    q.enqueue(makeEvent(1));
    q.enqueue(makeEvent(2));
    q.enqueue(makeEvent(3));

    q.startWorker(async (event) => {
      concurrent++;
      if (concurrent > maxConcurrent) {
        maxConcurrent = concurrent;
      }
      // Simulate async work
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      processed.push(event.id);
      concurrent--;
    });

    // Wait for all events to be processed
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    await q.shutdown(1);

    expect(maxConcurrent).toBe(1);
    expect(processed).toEqual([1, 2, 3]);
  });

  it('shutdown waits for in-flight event', async () => {
    const q = createEventQueue();
    let eventFinished = false;

    q.enqueue(makeEvent(1));

    q.startWorker(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      eventFinished = true;
    });

    // Let the worker pick up the event
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    await q.shutdown(5);
    expect(eventFinished).toBe(true);
  });

  it('shutdown resolves even if queue is empty', async () => {
    const q = createEventQueue();
    q.startWorker(async () => {});

    // Should resolve quickly without hanging
    await q.shutdown(1);
  });

  it('new events after shutdown are not processed', async () => {
    const q = createEventQueue();
    const processed: number[] = [];

    q.startWorker(async (event) => {
      processed.push(event.id);
    });

    // Let the worker start
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    await q.shutdown(1);

    // Enqueue after shutdown
    q.enqueue(makeEvent(99));

    // Give time for any processing
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(processed).toEqual([]);
    // The event stays in the queue (or is silently dropped)
    // Per design: enqueue after shutdown is a no-op
    expect(q.length).toBe(0);
  });

  it('worker picks up events enqueued after startWorker', async () => {
    const q = createEventQueue();
    const processed: number[] = [];

    q.startWorker(async (event) => {
      processed.push(event.id);
    });

    // Enqueue after worker is already waiting
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    q.enqueue(makeEvent(1));
    q.enqueue(makeEvent(2));

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await q.shutdown(1);

    expect(processed).toEqual([1, 2]);
  });
});
