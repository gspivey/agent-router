#!/usr/bin/env node
/**
 * Cwd-independent launcher for the agent-router CLI.
 *
 * Why this exists: `node --import tsx/esm <file>` resolves the `tsx/esm`
 * specifier relative to the process's current working directory, not the
 * script being run. When the CLI is installed (npm link / npm install -g)
 * and invoked from any directory that doesn't itself contain
 * `node_modules/tsx/`, the import fails with ERR_MODULE_NOT_FOUND.
 *
 * Putting the import in a `.mjs` file changes the resolution base to this
 * file's own location, which (via realpath() through any npm-link symlinks)
 * sits next to the package's `node_modules/`. The dynamic import of the
 * `.ts` CLI then succeeds because tsx's loader is already registered.
 */
import 'tsx/esm';
await import('./agent-router.ts');
