import type { Hono } from 'hono';
import type { Database } from './db';
import type { QueuedEvent } from './queue';

export function createApp(deps: {
  webhookSecret: string;
  db: Database;
  enqueue: (event: QueuedEvent) => void;
}): Hono {
  throw new Error('Not implemented');
}

export function verifySignature(
  secret: string,
  payload: Buffer,
  signature: string
): boolean {
  throw new Error('Not implemented');
}
