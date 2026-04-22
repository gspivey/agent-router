export interface McpContext {
  sessionId: string;
  daemonSocket: string;
}

export interface McpServer {
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createMcpServer(ctx: McpContext): McpServer {
  throw new Error('Not implemented');
}
