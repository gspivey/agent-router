# Tasks: Claude Code Adapter for agent-router

## Task 1: Add `RepoAdapterConfig` to config schema

**File:** `src/config.ts`

### Steps:

1. Add the `RepoAdapterConfig` interface:
   ```typescript
   export interface RepoAdapterConfig {
     type: 'kiro' | 'claude-code';
     model?: string;
   }
   ```

2. Add optional `adapter?: RepoAdapterConfig` field to `RepoConfig` interface.

3. Add validation logic inside the `repos` loop in `validateConfig`:
   - If `adapter` is present, assert it's an object.
   - `adapter.type` is required; must be `"kiro"` or `"claude-code"`. Unknown values → `FatalError`.
   - `adapter.model` is optional; if present, must be a non-empty string.
   - After the repos loop: for each repo with `adapter.type === "claude-code"`, if `ANTHROPIC_API_KEY` is not in `process.env` and not in `childEnvAllowlist`, log a WARN (not a FatalError — the key may be injected at session spawn time).

### Acceptance:
- `typecheck` passes.
- Config with `adapter: { type: "claude-code", model: "claude-opus-5" }` validates successfully.
- Config with `adapter: { type: "unknown" }` throws FatalError with descriptive message.
- Config with `adapter: { type: "claude-code", model: "" }` throws FatalError.

---

## Task 2: Create `src/adapters/claude-code.ts`

**File:** `src/adapters/claude-code.ts` (new)

### Steps:

1. Create the file implementing `AgentAdapter`:
   - `name`: `'claude-code'`
   - `capabilities()`: returns `{ events: ['session.start', 'tool.post', 'turn.end', 'session.end'], perToolMatching: true }`
   - `spawn(opts)`: calls `spawnACPClient('npx', ['@agentclientprotocol/claude-agent-acp@latest', '--acp'], env)` with:
     - `AGENT_ROUTER_SESSION_ID` from `opts.sessionId`
     - `ANTHROPIC_MODEL` from `deps.model` (if provided)
     - Spread of `opts.env`
   - `installHooks`: stub that logs info message
   - `uninstallHooks`: no-op stub

2. Export `createClaudeCodeAdapter` factory function and `ClaudeCodeAdapterDeps` interface.

3. Accept a `spawnImpl` dep override for unit testing (same pattern as KiroAdapter).

### Acceptance:
- `typecheck` passes.
- Unit test confirms spawn is called with correct binary (`npx`), args (`['@agentclientprotocol/claude-agent-acp@latest', '--acp']`), and env includes `AGENT_ROUTER_SESSION_ID` and `ANTHROPIC_MODEL`.

---

## Task 3: Wire adapter selection in `src/index.ts`

**File:** `src/index.ts`

### Steps:

1. Add import for `createClaudeCodeAdapter` from `./adapters/claude-code.js`.

2. After the existing `createKiroAdapter` call, build a `Map<string, AgentAdapter>` keyed by repo slug (`owner/name`):
   ```typescript
   const adapters = new Map<string, AgentAdapter>();
   for (const repo of config.repos) {
     const slug = `${repo.owner}/${repo.name}`;
     if (!repo.adapter || repo.adapter.type === 'kiro') {
       adapters.set(slug, adapter); // the default kiro adapter
     } else if (repo.adapter.type === 'claude-code') {
       adapters.set(slug, createClaudeCodeAdapter({
         model: repo.adapter.model,
         log,
       }));
     }
   }
   ```

3. Modify the `acpSpawner` lambda to select adapter based on `repo` argument:
   ```typescript
   const adapterForRepo = repo ? (adapters.get(repo) ?? adapter) : adapter;
   // Replace: adapter.spawn({ sessionId, env })
   // With:    adapterForRepo.spawn({ sessionId, env })
   ```

4. Log the adapter name for each repo at startup:
   ```typescript
   log.info('Agent adapter initialized', { adapter: adapter.name });
   for (const [slug, a] of adapters) {
     if (a.name !== 'kiro') {
       log.info('Per-repo adapter override', { repo: slug, adapter: a.name });
     }
   }
   ```

5. On config hot-reload, rebuild the adapter map with the new config's repo list.

### Acceptance:
- `typecheck` passes.
- Repos without `adapter` config still use kiro adapter (no behavioral change).
- Repos with `adapter.type: "claude-code"` spawn via `createClaudeCodeAdapter`.
- Adapter map is rebuilt on config reload.

---

## Task 4: Handle adapter map rebuild on config reload

**File:** `src/index.ts`

### Steps:

1. Extract the adapter-map building logic into a helper function:
   ```typescript
   function buildAdapterMap(
     repos: RepoConfig[],
     defaultAdapter: AgentAdapter,
     log: Logger,
   ): Map<string, AgentAdapter> { ... }
   ```

2. Call it at startup and again inside the `watchConfig` callback when `repos` changes.

3. Store the adapter map in a mutable holder (similar to `configHolder`):
   ```typescript
   const adapterMapHolder = { current: buildAdapterMap(config.repos, adapter, log) };
   ```

4. Update the `acpSpawner` lambda to read from `adapterMapHolder.current`.

### Acceptance:
- Changing a repo's adapter type in config.json and triggering a reload causes new sessions to use the new adapter.
- Active sessions are unaffected by the reload.

---

## Task 5: Add unit tests for the Claude Code adapter

**File:** `test/adapters/claude-code.test.ts` (new)

### Steps:

1. Test `createClaudeCodeAdapter` with a mock `spawnImpl`:
   - Verify spawn is called with `'npx'` as binary.
   - Verify args are `['@agentclientprotocol/claude-agent-acp@latest', '--acp']`.
   - Verify env includes `AGENT_ROUTER_SESSION_ID`.
   - Verify `ANTHROPIC_MODEL` is set when `model` dep is provided.
   - Verify `ANTHROPIC_MODEL` is NOT set when `model` is undefined.
   - Verify `opts.env` keys are forwarded.

2. Test `capabilities()` returns expected shape.

3. Test `name` is `'claude-code'`.

### Acceptance:
- `vitest run` passes with new test file.

---

## Task 6: Add config validation tests for adapter field

**File:** `test/config.test.ts` (extend existing)

### Steps:

1. Add test cases for valid adapter configs:
   - `adapter: { type: "kiro" }` → passes validation.
   - `adapter: { type: "claude-code" }` → passes validation.
   - `adapter: { type: "claude-code", model: "claude-opus-5" }` → passes validation.
   - No `adapter` field → passes validation (backward compat).

2. Add test cases for invalid adapter configs:
   - `adapter: { type: "opencode" }` → FatalError with message containing "adapter.type".
   - `adapter: { type: "claude-code", model: "" }` → FatalError.
   - `adapter: "claude-code"` (not an object) → FatalError.
   - `adapter: { }` (missing type) → FatalError.

### Acceptance:
- `vitest run` passes with new test cases.

---

## Task 7: End-to-end verification

### Steps:

1. Run `npm run typecheck` — must pass with zero errors.
2. Run `npm test` — all existing tests must pass unchanged.
3. Verify a sample config with `adapter.type: "claude-code"` on one repo loads without error.
4. Verify a sample config with no adapter fields loads without error (regression check).

### Acceptance:
- Typecheck clean.
- Test suite green.
- Manual verification of config loading for both adapter types.
