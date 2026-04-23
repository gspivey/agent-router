/**
 * RealKiroBackend — wraps the real kiro-cli binary for Tier 3 tests.
 *
 * Reads KIRO_PATH from env to locate the real Kiro CLI executable.
 * getActions() parses the session's stream.log to extract agent actions.
 *
 * Requirements: 22.2, 24.7
 */
import * as fs from 'node:fs';
import type { KiroBackend, AgentAction } from './interfaces.js';

export class RealKiroBackend implements KiroBackend {
  private kiroPath: string;

  constructor() {
    const envPath = process.env['KIRO_PATH'];
    if (!envPath) {
      throw new Error(
        'Required environment variable KIRO_PATH is not set. ' +
        'Tier 3 tests require a real Kiro CLI installation.',
      );
    }
    this.kiroPath = envPath;
  }

  spawnConfig(): { command: string; args: string[]; env: Record<string, string> } {
    return {
      command: this.kiroPath,
      args: ['acp'],
      env: {},
    };
  }

  /**
   * No-op for real backend — the real agent decides its own behavior.
   */
  async loadScenario(_scenarioPath: string): Promise<void> {
    // No-op: real Kiro doesn't use scenario scripts.
  }

  /**
   * Parse the session's stream.log to extract agent actions.
   * Each line is an NDJSON StreamEntry; we extract entries with
   * source: "agent" and translate them into AgentAction objects.
   */
  async getActions(sessionId: string): Promise<AgentAction[]> {
    const rootDir = process.env['AGENT_ROUTER_HOME'] ?? `${process.env['HOME']}/.agent-router`;
    const streamPath = `${rootDir}/sessions/${sessionId}/stream.log`;

    if (!fs.existsSync(streamPath)) {
      return [];
    }

    const content = fs.readFileSync(streamPath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const actions: AgentAction[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry['source'] === 'agent') {
          actions.push({
            type: entry['type'] as string,
            data: entry,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }

    return actions;
  }

  /**
   * No-op for real backend.
   */
  async reset(): Promise<void> {
    // No-op: nothing to reset for the real Kiro backend.
  }
}
