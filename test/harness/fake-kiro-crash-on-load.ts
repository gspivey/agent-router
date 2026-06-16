/**
 * Fake kiro subprocess that succeeds on initialize but exits with code 1
 * on session/load WITHOUT sending a response — causing the parent's
 * loadSession() to reject with "stdout closed before response received".
 */
import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, terminal: false });

for await (const line of rl) {
  if (!line.trim()) continue;
  const req = JSON.parse(line) as { id: number; method: string };

  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { protocolVersion: 1, serverCapabilities: [], serverInfo: { name: 'fake-kiro-crash', version: '0.0.1' } },
    }) + '\n');
    continue;
  }

  if (req.method === 'session/load') {
    // Crash without responding — simulates a failed session/load
    process.exit(1);
  }

  // Default: respond OK
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } }) + '\n');
}
