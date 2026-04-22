export interface NewEvent {
  repo: string;
  prNumber: number | null;
  eventType: string;
  payload: string;
  receivedAt: number;
}

export interface Session {
  sessionId: string;
  repo: string;
  prNumber: number;
  lastWakedAt: number | null;
}

export interface Database {
  insertEvent(event: NewEvent): number;
  updateEventProcessed(id: number, wakeTriggered: boolean): void;
  markStaleEvents(olderThanSeconds: number): void;
  findSession(repo: string, prNumber: number): Session | null;
  tryAcquireWakeSlot(
    repo: string,
    prNumber: number,
    cooldownSeconds: number,
    nowSeconds: number
  ): boolean;
  walCheckpoint(): void;
  shutdown(): Promise<void>;
}

export function initDatabase(dbPath: string): Database {
  throw new Error('Not implemented');
}
