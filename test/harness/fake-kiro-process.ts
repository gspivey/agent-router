/**
 * Subprocess that speaks ACP JSON-RPC 2.0 over stdio.
 * Behavior is driven by FAKE_KIRO_SCENARIO env var pointing to a scenario JSON file.
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';

interface ACPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface ACPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ACPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface PeriodicConfig {
  notification: ACPNotification;
  intervalMs: number;
  count: number;
  exitAfter?: number;
}

interface ScenarioStep {
  trigger: string;
  notifications?: ACPNotification[];
  result?: unknown;
  exitCode?: number;
  delayMs?: number;
  periodic?: PeriodicConfig;
}

interface Scenario {
  name: string;
  steps: ScenarioStep[];
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function startPeriodic(config: PeriodicConfig): void {
  let sent = 0;
  const timer = setInterval(() => {
    send(config.notification);
    sent++;
    if (sent >= config.count) {
      clearInterval(timer);
      if (config.exitAfter !== undefined) {
        setTimeout(() => process.exit(config.exitAfter!), 50);
      }
    }
  }, config.intervalMs);
}

async function main(): Promise<void> {
  const scenarioPath = process.env['FAKE_KIRO_SCENARIO'];
  let scenario: Scenario = { name: 'default', steps: [] };

  if (scenarioPath && fs.existsSync(scenarioPath)) {
    scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as Scenario;
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: ACPRequest;
    try {
      req = JSON.parse(line) as ACPRequest;
    } catch {
      continue;
    }

    // Find a matching step
    const step = scenario.steps.find((s) => s.trigger === req.method);

    if (step?.delayMs) {
      await delay(step.delayMs);
    }

    // Handle initialize — always respond with protocol version 1
    if (req.method === 'initialize') {
      const result = step?.result ?? {
        protocolVersion: 1,
        serverCapabilities: [],
        serverInfo: { name: 'fake-kiro', version: '0.0.1' },
      };
      send({ jsonrpc: '2.0', id: req.id, result } satisfies ACPResponse);
      continue;
    }

    // Handle session/new — return a fake session ID
    if (req.method === 'session/new') {
      send({ jsonrpc: '2.0', id: req.id, result: { sessionId: 'fake-session-001' } } satisfies ACPResponse);
      continue;
    }

    // For other methods, emit notifications first then respond
    if (step) {
      for (const notification of step.notifications ?? []) {
        send(notification);
      }
      send({ jsonrpc: '2.0', id: req.id, result: step.result ?? { ok: true } } satisfies ACPResponse);

      // Start periodic notification emission if configured
      if (step.periodic) {
        startPeriodic(step.periodic);
      }

      if (step.exitCode !== undefined) {
        process.exit(step.exitCode);
      }
    } else {
      // Default: send empty ok response
      send({ jsonrpc: '2.0', id: req.id, result: { ok: true } } satisfies ACPResponse);
    }
  }

  // stdin closed — exit 0
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
