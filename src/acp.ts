export interface ACPNotification {
  method: string;
  params: unknown;
}

export interface ACPClient {
  initialize(): Promise<void>;
  loadSession(sessionId: string): Promise<void>;
  sendPrompt(prompt: string): Promise<void>;
  readonly notifications: AsyncIterable<ACPNotification>;
  readonly sessionEnded: Promise<void>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

export function spawnACPClient(kiroPath: string, args: string[]): ACPClient {
  throw new Error('Not implemented');
}
