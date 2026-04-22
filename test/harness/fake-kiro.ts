import * as path from 'node:path';
import * as url from 'node:url';
import * as fs from 'node:fs';
import type { KiroBackend, AgentAction } from './interfaces.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Path to the fake-kiro subprocess script
export const FAKE_KIRO_SCRIPT = path.resolve(__dirname, 'fake-kiro-process.ts');

export class FakeKiroBackend implements KiroBackend {
  private scenarioPath: string | null = null;

  spawnConfig(): { command: string; args: string[]; env: Record<string, string> } {
    return {
      command: 'node',
      args: ['--import', 'tsx/esm', FAKE_KIRO_SCRIPT],
      env: this.scenarioPath
        ? { FAKE_KIRO_SCENARIO: this.scenarioPath }
        : {},
    };
  }

  async loadScenario(scenarioPath: string): Promise<void> {
    if (!fs.existsSync(scenarioPath)) {
      throw new Error(`Scenario file not found: ${scenarioPath}`);
    }
    this.scenarioPath = scenarioPath;
  }

  async getActions(sessionId: string): Promise<AgentAction[]> {
    // FakeKiroBackend records actions via the scenario definition;
    // for test assertions the harness reads from the stream.log written by the daemon.
    return [];
  }

  async reset(): Promise<void> {
    this.scenarioPath = null;
  }
}
