import * as net from 'node:net';

export interface NewSessionResponse {
  session_id: string;
  stream_path: string;
  prompts_path: string;
}

export interface SessionMetaResponse {
  session_id: string;
  status: string;
  created_at: number;
  completed_at: number | null;
  prs: Array<{ repo: string; pr_number: number; registered_at: number }>;
  original_prompt: string;
}

export interface ListSessionsResponse {
  sessions: SessionMetaResponse[];
}

export class TestCli {
  constructor(private socketPath: string) {}

  async newSession(prompt: string): Promise<NewSessionResponse> {
    return this.send<NewSessionResponse>({ op: 'new_session', prompt });
  }

  async listSessions(): Promise<ListSessionsResponse> {
    return this.send<ListSessionsResponse>({ op: 'list_sessions' });
  }

  async injectPrompt(sessionId: string, prompt: string): Promise<{ ok: boolean }> {
    return this.send<{ ok: boolean }>({ op: 'inject_prompt', session_id: sessionId, prompt });
  }

  async terminateSession(sessionId: string): Promise<{ ok: boolean }> {
    return this.send<{ ok: boolean }>({ op: 'terminate_session', session_id: sessionId });
  }

  private send<T>(msg: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = '';

      socket.on('connect', () => {
        socket.write(JSON.stringify(msg) + '\n');
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const idx = buffer.indexOf('\n');
        if (idx !== -1) {
          const line = buffer.slice(0, idx);
          socket.destroy();
          try {
            resolve(JSON.parse(line) as T);
          } catch (e) {
            reject(e);
          }
        }
      });

      socket.on('error', reject);
      socket.on('close', () => {
        if (buffer) {
          try {
            resolve(JSON.parse(buffer) as T);
          } catch {
            reject(new Error('Socket closed without complete response'));
          }
        }
      });
    });
  }
}
