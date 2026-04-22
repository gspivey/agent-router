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
  throw new Error('Not implemented');
}
