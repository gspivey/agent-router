#!/usr/bin/env node
/**
 * Launcher for the agent-router MCP server.
 *
 * Mirrors bin/agent-router.mjs: registering tsx's ESM loader via a `.mjs`
 * shim makes the `tsx/esm` specifier resolve relative to this file's own
 * location (next to the package's node_modules/), so the dynamic import of
 * the TypeScript entry point succeeds from any working directory with no
 * build step.
 *
 * This calls runMcpServerFromEnv() explicitly rather than relying on the
 * isMainModule guard in mcp-server.ts — when launched through this shim,
 * process.argv[1] is this .mjs file, not mcp-server.ts, so the guard is false.
 */
import 'tsx/esm';
const m = await import('../src/mcp-server.ts');
m.runMcpServerFromEnv();
