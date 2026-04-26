# Agent Guide

This document describes how agents (and humans) should work in this codebase. It reflects how the project actually operates today, not how earlier specs imagined it.

## Source of truth

Different documents serve different purposes. Use the right one:

- **`README.md`** — how to operate the daemon, install, and run tests. First thing to read.
- **`PRODUCT.md`** — what the product is, what it does differently, open architecture questions.
- **`ROADMAP.md`** — strategic phase plan. What we're building over months.
- **`BACKLOG.md`** — tactical bug list and small specs. What to work on next.
- **`AGENTS.md`** (this doc) — how to do the work once you know what to do.
- **`.kiro/specs/agent-router/`** — historical specs from initial buildout. Most tasks are complete. Useful for understanding original intent; not authoritative for new work.
- **The code** — the most authoritative source for "how is this actually done." When docs and code disagree, the code wins.

## Working from the backlog

`BACKLOG.md` lists prioritized work items P0 through P3. Each item has a mini-spec sufficient to drive a Kiro spec generation. To work an item:

1. Pick the highest-priority unblocked item from `BACKLOG.md`.
2. If it has a clear "Mini spec" section, the mini spec drives the Kiro spec phase. Generate `requirements.md`, `design.md`, `tasks.md` under `.kiro/specs/<spec-group>/` if a fresh spec is needed for the change.
3. If it's a small fix (single-digit lines of code), skip the spec generation and implement directly.
4. Implement, write tests, run tests.
5. Tests must be green before opening a PR. No exceptions.
6. Open the PR. Update `BACKLOG.md` to mark the item done (or remove it).

For genuinely tactical bugs (typos, prompt edits), no spec is needed — just fix it.

## Coding conventions

These are settled patterns derived from the existing codebase. Follow them.

**Dependency injection over imports for testability.** Modules accept their dependencies (logger, database, clock, etc.) via constructor or function parameters. Don't reach out to module-level singletons in code that needs to be tested.

**Pure functions are exported individually.** Logic without side effects (parsers, validators, prompt composers) gets exported as standalone functions, not wrapped in classes, so they can be unit-tested directly.

**Three error classes for three failure modes:**

- `FatalError` — daemon cannot continue, exit
- `EventError` — this event cannot be processed, skip it, daemon continues
- `WakeError` — wake decision failed for this event, log and continue

Don't invent new error classes without a clear new failure mode.

**Structured logging always.** Use the `Logger` interface. `console.log` is prohibited outside the CLI client's pretty-printer.

**Closed-union string fields.** Status fields, termination reasons, trust tiers — these are closed unions in TypeScript. When adding a new value, update the union definition first; the compiler tells you everywhere it needs handling.

**Atomic writes for state.** `meta.json` writes go through temp-file-plus-rename. `stream.log` and `prompts.log` are append-only NDJSON. Never partial-write a state file.

**Synchronous SQLite, synchronous file I/O for session files.** `better-sqlite3` is sync by design. Session file operations use `fs` sync methods with explicit `fsync` for durability. Async is for HTTP and ACP transport, not for state writes.

## Testing rules

**Three tiers:**

- **Tier 1** (`test/tier1/`) — pure logic, unit tests, property tests. Fast. Property tests use `fast-check` with at least 100 iterations.
- **Tier 2** (`test/tier2/`) — full daemon against fake backends. Uses the test harness in `test/harness/` (`FakeGitHubBackend`, `FakeKiroBackend`, `TestDaemonImpl`). Scenario files in `test/scenarios/` script `FakeKiroBackend` behavior.
- **Tier 3** — real GitHub, real Kiro. Slow, network-dependent, consumes API quota. Run before shipping, not on every change.

**Tests must not require network access, real API tokens, or real Kiro for Tier 1 or Tier 2.** This is a hard rule.

**Test files use `.test.ts`.** Tier 1 tests can co-locate with source if they're testing pure logic in that module.

**Tier 2 coverage is required for any meaningful behavioral change.** A new wake policy rule, a new termination reason, a new MCP tool — all need Tier 2 coverage in addition to Tier 1.

## Style

- ESM imports with `.js` extensions in import paths (TypeScript with ESM resolution).
- Strict TypeScript — no `any`, no `as` casts unless absolutely necessary.
- No build step. `tsx` handles execution; `tsc --noEmit` handles type checking.

## Working with sessions and state

**Session state lives in two places.** In-memory in the session manager (active sessions), and on disk under `~/.agent-router/sessions/<id>/`. The on-disk state survives daemon restarts; the in-memory state does not (yet — see backlog P2.1).

**Per-session files:**

- `meta.json` — session metadata. Atomic-written. Source of truth for status, termination reason, registered PRs.
- `stream.log` — append-only NDJSON of every ACP event. Tailable from outside.
- `prompts.log` — append-only NDJSON of every prompt injected into the session.

**Don't bypass the session manager** when manipulating session state. All writes go through `session-mgr.ts` and `session-files.ts` for atomicity guarantees.

## Wake policy

The wake policy lives in `src/router.ts`. It's a pipeline:

1. Filter by event type
2. For comment events, compute trust tier from `comment.author_association`, `comment.user.login`, `comment.user.type`, `repository.owner.login`
3. Resolve the PR from the event payload
4. Look up an active session bound to that `(repo, pr)`
5. Apply rate limiting

Each step has a pure function exported for direct testing. When changing the wake policy, update the pure function, add Tier 1 tests for the function, and add a Tier 2 test that exercises the full pipeline through the daemon.

## What not to do

- **Don't add dependencies without a clear need.** This codebase deliberately keeps the dependency surface small. Justify any new import.
- **Don't introduce a build step.** `tsx` for execution, `tsc --noEmit` for type-checking. No bundlers, no transpilers, no compile-and-run flow.
- **Don't write to `console.log` in production code.** Use the structured logger.
- **Don't bypass atomic-write patterns** for state files. If you find yourself writing JSON without rename-after-write, you're doing it wrong.
- **Don't run Tier 3 tests on every change.** They're slow and consume real quota.
- **Don't add features that aren't in `BACKLOG.md` or `ROADMAP.md`** without first adding them there. Keeps the project's scope clear and prevents drive-by feature creep.
- **Don't merge a PR unless tests are green.** Including new tests that exercise the new behavior. Including Tier 2 if the change is behavioral.
- **Don't update documentation as a separate PR from the code change.** Docs land alongside the code that justifies them.