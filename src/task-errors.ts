/**
 * Task/attempt-domain error classes (task-attempt-outcome, task 1.4).
 *
 * Analogous to the existing `FatalError`/`EventError`/`WakeError` taxonomy in
 * `src/errors.ts`. A `TaskError`/`AttemptError` is scoped to a single task or
 * attempt: the daemon logs it via the structured logger and continues running —
 * it never crashes the daemon for one task's failure (Requirement 15.3/15.4).
 */

/** A failure scoped to a single task (submission, state transition, lookup). */
export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

/** A failure scoped to a single attempt (lifecycle, outcome resolution). */
export class AttemptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptError';
  }
}
