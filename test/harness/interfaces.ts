import type { Database as BetterSqlite3Database } from 'better-sqlite3';

export interface WebhookEvent {
  event: string;
  payload: unknown;
}

export interface APICall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface PRState {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  baseRef: string;
}

export interface PRSummary {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
}

export interface GitHubBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): Promise<void>;
  apiBaseUrl(): string;
  webhookTargetUrl(): string;
  cloneUrl(repo: string): string;
  sendWebhook(event: WebhookEvent): Promise<void>;
  createInitialPR(
    repo: string,
    branch: string,
    title: string,
    body: string
  ): Promise<number>;
  addComment(
    repo: string,
    prNumber: number,
    body: string,
    actor: string,
    options?: { actorType?: string; authorAssociation?: string },
  ): Promise<void>;
  reportCheckRun(
    repo: string,
    prNumber: number,
    name: string,
    conclusion: 'success' | 'failure'
  ): Promise<void>;
  getAPICalls(): Promise<APICall[]>;
  getPRState(repo: string, prNumber: number): Promise<PRState>;
  getAllPRs(repo: string): Promise<PRSummary[]>;
}

export interface AgentAction {
  type: string;
  data: unknown;
}

export interface KiroBackend {
  spawnConfig(): { command: string; args: string[]; env: Record<string, string> };
  loadScenario(scenarioPath: string): Promise<void>;
  getActions(sessionId: string): Promise<AgentAction[]>;
  reset(): Promise<void>;
}

export interface TestDaemonOptions {
  githubBackend: GitHubBackend;
  kiroBackend: KiroBackend;
  webhookSecret: string;
  owner: string;
  repo: string;
}

export interface TestDaemon {
  start(options: TestDaemonOptions): Promise<void>;
  stop(): Promise<void>;
  socketPath(): string;
  webhookUrl(): string;
  rootDir(): string;
  getDb(): BetterSqlite3Database;
}
