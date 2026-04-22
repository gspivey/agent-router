# Agent Guide

## Task Execution Protocol

1. Read the spec at `.kiro/specs/agent-router/` — `requirements.md`, `design.md`, and `tasks.md` are the source of truth.
2. Find the first task in `tasks.md` (numerical order) not marked complete.
3. Implement the task.
4. Run tests: `npm test` (Tier 1 + Tier 2). If the test harness or integration tests exist, run them.
5. If tests fail, fix the code. Do not move on until tests are green.
6. Mark the task complete in `tasks.md`.

Do not declare a task complete unless tests pass. Do not skip tasks. Do not work ahead.

Tasks marked with `*` are optional. Tier 2 tests within each feature task are NOT optional.
Checkpoints (Tasks 7, 12, 18, 20) require all tests green before proceeding.

## Coding Conventions

- Every module that produces runtime behavior accepts a `Logger` as a constructor dependency.
- `console.log` is prohibited outside the CLI client's pretty-printer. Use the structured logger.
- Functions that are pure logic (no I/O) should be exported individually for direct unit testing.
- Error handling uses the three error classes: `FatalError` (exit), `EventError` (skip event), `WakeError` (log + continue).
- Prefer dependency injection over imports for testability — constructors take their deps as arguments.
- All interfaces are defined in the module that owns them (e.g., `Database` in `db.ts`, `Logger` in `log.ts`).

## Testing Rules

- Tier 1 tests go in `test/tier1/`. Pure-logic unit tests may also co-locate with source.
- Tier 2 tests go in `test/tier2/`. These exercise the full daemon against fake backends.
- Property tests use `fast-check` with a minimum of 100 iterations.
- Test files use `.test.ts` extension.
- Use the test harness (`test/harness/`) for Tier 2 — `FakeGitHubBackend`, `FakeKiroBackend`, `TestDaemonImpl`.
- Scenario files in `test/scenarios/` drive `FakeKiroBackend` behavior.
- Never require network access, real API tokens, or real Kiro for Tier 1 or Tier 2 tests.

## Style

- ESM imports with `.js` extensions in import paths (TypeScript with ESM resolution).
- Strict TypeScript — no `any`, no `as` casts unless absolutely necessary.
- Synchronous SQLite operations via `better-sqlite3` — no async DB calls.
- File I/O for session files uses synchronous `fs` methods with explicit `fsync` for durability.
- Atomic writes for `meta.json` via temp-file-plus-rename pattern.
- Append-only writes for `stream.log` and `prompts.log`.

## What Not To Do

- Do not add dependencies without explicit approval.
- Do not create a build step — `tsx` handles execution, `tsc --noEmit` handles type checking.
- Do not use `console.log` in production code.
- Do not write Tier 3 tests until Task 18.5.
- Do not modify interfaces defined in the design without discussing the change first.
