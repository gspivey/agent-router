import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Resolve the command, args, and serverPath for launching the per-session MCP
 * server (`src/mcp-server.ts` in dev / its compiled `.js` form in production).
 *
 * Pure except for a filesystem existence probe (needed to pick `.ts` vs `.js`).
 * Returns `undefined` when neither `mcp-server.ts` nor `mcp-server.js` exists
 * under `moduleDir` — callers treat that as graceful degradation (no MCP
 * wiring).
 *
 * The resolved `command`/`args` launch the entry point such that the
 * main-module guard in `mcp-server.ts` fires (its check matches `argv[1]`
 * ending in `mcp-server.ts` or `mcp-server.js`):
 *   - `.ts` → `node --import <tsx/esm URL> <abs path>` (no build step)
 *   - `.js` → `node <abs path>`
 *
 * @param moduleDir  Absolute path to the directory containing mcp-server.ts/js
 *                   (the daemon's own module directory, not process.cwd()).
 * @param resolve    Resolves a module specifier to an absolute URL/path. Pass
 *                   `import.meta.resolve` in production, a fixture in tests.
 */
export function resolveMcpServerCommand(
  moduleDir: string,
  resolve: (specifier: string) => string,
): { command: string; args: string[]; serverPath: string } | undefined {
  const mcpTs = path.join(moduleDir, 'mcp-server.ts');
  const mcpJs = path.join(moduleDir, 'mcp-server.js');
  const serverPath = fs.existsSync(mcpTs) ? mcpTs : fs.existsSync(mcpJs) ? mcpJs : undefined;
  if (serverPath === undefined) return undefined;

  const isTs = serverPath.endsWith('.ts');
  const command = process.execPath; // the current node binary
  // Resolve tsx/esm to an absolute URL so Node finds it regardless of the MCP
  // child's working directory (Node resolves --import specifiers from cwd).
  const args = isTs ? ['--import', resolve('tsx/esm')] : [];

  return { command, args, serverPath };
}
