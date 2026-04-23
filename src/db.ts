import BetterSqlite3 from 'better-sqlite3';

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
  insertSession(repo: string, prNumber: number, sessionId: string): void;
  walCheckpoint(): void;
  shutdown(): Promise<void>;
}

const SESSIONS_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo          TEXT NOT NULL,
  pr_number     INTEGER NOT NULL,
  session_id    TEXT NOT NULL,
  last_waked_at INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE(repo, pr_number)
);
`;

const SESSIONS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_repo_pr
  ON sessions(repo, pr_number);
`;

const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo            TEXT NOT NULL,
  pr_number       INTEGER,
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  received_at     INTEGER NOT NULL,
  processed_at    INTEGER,
  wake_triggered  INTEGER CHECK (wake_triggered IN (0, 1))
);
`;

const EVENTS_INDEX_UNPROCESSED = `
CREATE INDEX IF NOT EXISTS idx_events_unprocessed
  ON events(processed_at) WHERE processed_at IS NULL;
`;

const EVENTS_INDEX_REPO_PR = `
CREATE INDEX IF NOT EXISTS idx_events_repo_pr
  ON events(repo, pr_number);
`;

export function initDatabase(dbPath: string): Database {
  const db = new BetterSqlite3(dbPath);

  // Enable WAL mode for concurrent reads during writes
  db.pragma('journal_mode = WAL');

  // Execute DDL
  db.exec(SESSIONS_DDL);
  db.exec(SESSIONS_INDEX);
  db.exec(EVENTS_DDL);
  db.exec(EVENTS_INDEX_UNPROCESSED);
  db.exec(EVENTS_INDEX_REPO_PR);

  // Prepared statements
  const insertEventStmt = db.prepare<{
    repo: string;
    pr_number: number | null;
    event_type: string;
    payload: string;
    received_at: number;
  }>(
    `INSERT INTO events (repo, pr_number, event_type, payload, received_at)
     VALUES (@repo, @pr_number, @event_type, @payload, @received_at)`
  );

  const updateEventProcessedStmt = db.prepare<{
    id: number;
    processed_at: number;
    wake_triggered: number;
  }>(
    `UPDATE events
     SET processed_at = @processed_at, wake_triggered = @wake_triggered
     WHERE id = @id`
  );

  const markStaleEventsStmt = db.prepare<{
    cutoff: number;
    now: number;
  }>(
    `UPDATE events
     SET processed_at = @now, wake_triggered = 0
     WHERE processed_at IS NULL AND received_at < @cutoff`
  );

  const findSessionStmt = db.prepare<{
    repo: string;
    pr_number: number;
  }>(
    `SELECT session_id, repo, pr_number, last_waked_at
     FROM sessions
     WHERE repo = @repo AND pr_number = @pr_number`
  );

  const insertSessionStmt = db.prepare<{
    repo: string;
    pr_number: number;
    session_id: string;
    created_at: number;
  }>(
    `INSERT INTO sessions (repo, pr_number, session_id, created_at)
     VALUES (@repo, @pr_number, @session_id, @created_at)`
  );

  const acquireWakeSlotStmt = db.prepare<{
    repo: string;
    pr_number: number;
    now: number;
  }>(
    `UPDATE sessions
     SET last_waked_at = @now
     WHERE repo = @repo AND pr_number = @pr_number`
  );

  const checkWakeSlotStmt = db.prepare<{
    repo: string;
    pr_number: number;
  }>(
    `SELECT last_waked_at FROM sessions
     WHERE repo = @repo AND pr_number = @pr_number`
  );

  // Atomic rate-limit transaction
  const tryAcquireWakeSlotTxn = db.transaction(
    (repo: string, prNumber: number, cooldownSeconds: number, nowSeconds: number): boolean => {
      const row = checkWakeSlotStmt.get({ repo, pr_number: prNumber }) as
        | { last_waked_at: number | null }
        | undefined;

      if (row === undefined) {
        return false;
      }

      const lastWakedAt = row.last_waked_at;
      if (lastWakedAt !== null && (nowSeconds - lastWakedAt) < cooldownSeconds) {
        return false;
      }

      acquireWakeSlotStmt.run({ repo, pr_number: prNumber, now: nowSeconds });
      return true;
    }
  );

  const database: Database = {
    insertEvent(event: NewEvent): number {
      const result = insertEventStmt.run({
        repo: event.repo,
        pr_number: event.prNumber,
        event_type: event.eventType,
        payload: event.payload,
        received_at: event.receivedAt,
      });
      return Number(result.lastInsertRowid);
    },

    updateEventProcessed(id: number, wakeTriggered: boolean): void {
      updateEventProcessedStmt.run({
        id,
        processed_at: Math.floor(Date.now() / 1000),
        wake_triggered: wakeTriggered ? 1 : 0,
      });
    },

    markStaleEvents(olderThanSeconds: number): void {
      const now = Math.floor(Date.now() / 1000);
      const cutoff = now - olderThanSeconds;
      markStaleEventsStmt.run({ cutoff, now });
    },

    findSession(repo: string, prNumber: number): Session | null {
      const row = findSessionStmt.get({ repo, pr_number: prNumber }) as
        | { session_id: string; repo: string; pr_number: number; last_waked_at: number | null }
        | undefined;

      if (row === undefined) {
        return null;
      }

      return {
        sessionId: row.session_id,
        repo: row.repo,
        prNumber: row.pr_number,
        lastWakedAt: row.last_waked_at,
      };
    },

    tryAcquireWakeSlot(
      repo: string,
      prNumber: number,
      cooldownSeconds: number,
      nowSeconds: number
    ): boolean {
      return tryAcquireWakeSlotTxn(repo, prNumber, cooldownSeconds, nowSeconds);
    },

    insertSession(repo: string, prNumber: number, sessionId: string): void {
      insertSessionStmt.run({
        repo,
        pr_number: prNumber,
        session_id: sessionId,
        created_at: Math.floor(Date.now() / 1000),
      });
    },

    walCheckpoint(): void {
      db.pragma('wal_checkpoint(TRUNCATE)');
    },

    shutdown(): Promise<void> {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      return Promise.resolve();
    },
  };

  return database;
}
