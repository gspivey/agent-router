export interface QueuedEvent {
  id: number;
  repo: string;
  prNumber: number | null;
  eventType: string;
  payload: string;
  source: 'webhook' | 'cron';
}

export interface EventQueue {
  enqueue(event: QueuedEvent): void;
  startWorker(processor: (event: QueuedEvent) => Promise<void>): void;
  shutdown(timeoutSeconds: number): Promise<void>;
  readonly length: number;
}

export function createEventQueue(): EventQueue {
  const queue: QueuedEvent[] = [];
  let shuttingDown = false;
  let workerRunning = false;

  // Signal used to wake the worker when a new event is enqueued
  let notifyWorker: (() => void) | null = null;

  // Tracks the currently in-flight processor promise
  let inFlightPromise: Promise<void> | null = null;

  // Resolved when the worker loop exits
  let workerDoneResolve: (() => void) | null = null;
  let workerDonePromise: Promise<void> | null = null;

  function waitForEvent(): Promise<void> {
    return new Promise<void>((resolve) => {
      notifyWorker = resolve;
    });
  }

  async function runWorker(processor: (event: QueuedEvent) => Promise<void>): Promise<void> {
    while (true) {
      if (shuttingDown) {
        break;
      }

      const event = queue.shift();
      if (event === undefined) {
        // Wait until enqueue or shutdown signals us
        await waitForEvent();
        continue;
      }

      // Process the event
      inFlightPromise = processor(event);
      try {
        await inFlightPromise;
      } catch {
        // Processor errors are swallowed — the caller is responsible for error handling
      } finally {
        inFlightPromise = null;
      }
    }
  }

  return {
    enqueue(event: QueuedEvent): void {
      if (shuttingDown) {
        return;
      }
      queue.push(event);
      if (notifyWorker !== null) {
        const wake = notifyWorker;
        notifyWorker = null;
        wake();
      }
    },

    startWorker(processor: (event: QueuedEvent) => Promise<void>): void {
      if (workerRunning) {
        return;
      }
      workerRunning = true;
      workerDonePromise = new Promise<void>((resolve) => {
        workerDoneResolve = resolve;
      });
      runWorker(processor).then(() => {
        workerRunning = false;
        if (workerDoneResolve !== null) {
          workerDoneResolve();
        }
      });
    },

    async shutdown(timeoutSeconds: number): Promise<void> {
      shuttingDown = true;

      // Wake the worker if it's waiting for events
      if (notifyWorker !== null) {
        const wake = notifyWorker;
        notifyWorker = null;
        wake();
      }

      // If there's an in-flight event, wait for it up to the timeout
      if (inFlightPromise !== null) {
        const timeoutMs = timeoutSeconds * 1000;
        await Promise.race([
          inFlightPromise.catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      }

      // Wait for the worker loop to exit
      if (workerDonePromise !== null) {
        await workerDonePromise;
      }
    },

    get length(): number {
      return queue.length;
    },
  };
}
