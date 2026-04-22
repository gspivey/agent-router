# Tech Stack

## Runtime & Language
- Node.js 20+ with TypeScript (strict mode)
- ESM modules (`"type": "module"` in package.json)
- `tsx` for dev execution — no separate build step for MVP
- `tsc --noEmit` for type checking only

## Dependencies
- **hono** + **@hono/node-server** — HTTP framework
- **better-sqlite3** — synchronous SQLite (WAL mode)
- **node-cron** — cron scheduling
- **tsx** — TypeScript execution

## Dev Dependencies
- **vitest** — test runner
- **fast-check** — property-based testing
- **typescript** — strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`

## tsconfig Highlights
- Target: ES2022, Module: ESNext, ModuleResolution: Bundler
- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`
- `noEmit: true` — type checking only, no compiled output

## Common Commands

| Command | Purpose |
|---|---|
| `npm start` | Run daemon via `node --import tsx/esm src/index.ts` |
| `npm run dev` | Run daemon via `tsx src/index.ts` |
| `npm run typecheck` | Type check with `tsc --noEmit` |
| `npm test` | Run Tier 1 + Tier 2 tests (`vitest run --project tier1 --project tier2`) |
| `npm run test:watch` | Watch Tier 1 tests only |
| `npm run test:integration` | Run Tier 3 tests (requires real GitHub + Kiro) |
| `npm run test:all` | Run all three tiers |

## Testing Tiers
- **Tier 1** (`test/tier1/`): Unit and property tests. No external deps. Milliseconds.
- **Tier 2** (`test/tier2/`): Full daemon against fake backends. Requires Node.js + git only. Seconds.
- **Tier 3** (`test/tier3/`): Full daemon against real GitHub + real Kiro. Requires `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `KIRO_PATH` env vars. Minutes.

Property tests use fast-check with a minimum of 100 iterations per property.
