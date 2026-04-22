import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';
import type {
  GitHubBackend,
  WebhookEvent,
  APICall,
  PRState,
  PRSummary,
} from './interfaces.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_REPO = path.resolve(__dirname, '../fixtures/repos/integration-test-repo.git');

interface PRRecord {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  baseRef: string;
  headSha: string;
}

interface CheckRunRecord {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  prNumber: number;
}

interface CommentRecord {
  id: number;
  body: string;
  actor: string;
  prNumber: number;
}

export class FakeGitHubBackend implements GitHubBackend {
  private server: http.Server | null = null;
  private port = 0;
  private webhookSecret: string;
  private daemonWebhookUrl = '';

  private prs: Map<string, Map<number, PRRecord>> = new Map();
  private prCounter = 1;
  private checkRuns: CheckRunRecord[] = [];
  private checkRunCounter = 1;
  private comments: CommentRecord[] = [];
  private commentCounter = 1;
  private apiCalls: APICall[] = [];

  constructor(webhookSecret: string) {
    this.webhookSecret = webhookSecret;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  async reset(): Promise<void> {
    this.prs.clear();
    this.prCounter = 1;
    this.checkRuns = [];
    this.checkRunCounter = 1;
    this.comments = [];
    this.commentCounter = 1;
    this.apiCalls = [];
    // Recreate the fixture repo
    const scriptPath = path.resolve(__dirname, 'scripts/make-fixture-repo.sh');
    execSync(scriptPath, { stdio: 'pipe' });
  }

  apiBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  webhookTargetUrl(): string {
    return this.daemonWebhookUrl;
  }

  setDaemonWebhookUrl(url: string): void {
    this.daemonWebhookUrl = url;
  }

  cloneUrl(repo: string): string {
    return `file://${FIXTURE_REPO}`;
  }

  async sendWebhook(event: WebhookEvent): Promise<void> {
    if (!this.daemonWebhookUrl) throw new Error('daemonWebhookUrl not set');
    const body = JSON.stringify(event.payload);
    const sig = this.signPayload(body);
    await fetch(this.daemonWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event.event,
        'X-Hub-Signature-256': sig,
      },
      body,
    });
  }

  async createInitialPR(
    repo: string,
    branch: string,
    title: string,
    body: string
  ): Promise<number> {
    // Create a real branch on the fixture repo
    const headSha = this.getLatestSha('main');
    execSync(
      `git -C "${FIXTURE_REPO}" branch "${branch}" main`,
      { stdio: 'pipe' }
    );

    if (!this.prs.has(repo)) this.prs.set(repo, new Map());
    const num = this.prCounter++;
    this.prs.get(repo)!.set(num, {
      number: num,
      title,
      body,
      state: 'open',
      headRef: branch,
      baseRef: 'main',
      headSha,
    });
    return num;
  }

  async addComment(
    repo: string,
    prNumber: number,
    body: string,
    actor: string
  ): Promise<void> {
    const id = this.commentCounter++;
    this.comments.push({ id, body, actor, prNumber });

    await this.sendWebhookToRepo(repo, prNumber, 'issue_comment', {
      action: 'created',
      issue: {
        number: prNumber,
        pull_request: { url: `https://github.com/${repo}/pull/${prNumber}` },
      },
      comment: { id, body, user: { login: actor } },
      repository: { full_name: repo },
    });
  }

  async reportCheckRun(
    repo: string,
    prNumber: number,
    name: string,
    conclusion: 'success' | 'failure'
  ): Promise<void> {
    const id = this.checkRunCounter++;
    const pr = this.prs.get(repo)?.get(prNumber);
    this.checkRuns.push({ id, name, status: 'completed', conclusion, prNumber });

    await this.sendWebhookToRepo(repo, prNumber, 'check_run', {
      action: 'completed',
      check_run: {
        id,
        name,
        status: 'completed',
        conclusion,
        output: { summary: `Check ${conclusion}`, text: '' },
        pull_requests: pr ? [{ number: prNumber, url: `https://github.com/${repo}/pull/${prNumber}` }] : [],
      },
      repository: { full_name: repo },
    });
  }

  async getAPICalls(): Promise<APICall[]> {
    return [...this.apiCalls];
  }

  async getPRState(repo: string, prNumber: number): Promise<PRState> {
    const pr = this.prs.get(repo)?.get(prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not found in ${repo}`);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
    };
  }

  async getAllPRs(repo: string): Promise<PRSummary[]> {
    const repoPRs = this.prs.get(repo);
    if (!repoPRs) return [];
    return Array.from(repoPRs.values()).map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
    }));
  }

  private signPayload(body: string): string {
    const hmac = crypto.createHmac('sha256', this.webhookSecret);
    hmac.update(body);
    return `sha256=${hmac.digest('hex')}`;
  }

  private getLatestSha(branch: string): string {
    return execSync(`git -C "${FIXTURE_REPO}" rev-parse ${branch}`, { encoding: 'utf8' }).trim();
  }

  private async sendWebhookToRepo(
    repo: string,
    prNumber: number,
    event: string,
    payload: unknown
  ): Promise<void> {
    if (!this.daemonWebhookUrl) return;
    await this.sendWebhook({ event, payload });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? (JSON.parse(rawBody) as unknown) : undefined;

    const parsedUrl = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const pathname = parsedUrl.pathname;
    const method = req.method ?? 'GET';

    this.apiCalls.push({
      method,
      path: pathname,
      headers: req.headers as Record<string, string>,
      body,
    });

    // Minimal GitHub REST API subset
    const reposMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!reposMatch) {
      res.writeHead(404).end(JSON.stringify({ message: 'Not Found' }));
      return;
    }

    const repoName = reposMatch[1]!;
    const subPath = reposMatch[2] ?? '';

    // GET /repos/:owner/:repo
    if (method === 'GET' && subPath === '') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ full_name: repoName, clone_url: this.cloneUrl(repoName) })
      );
      return;
    }

    // GET /repos/:owner/:repo/pulls
    if (method === 'GET' && subPath === '/pulls') {
      const prs = await this.getAllPRs(repoName);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(prs));
      return;
    }

    // GET /repos/:owner/:repo/pulls/:number
    const pullMatch = subPath.match(/^\/pulls\/(\d+)$/);
    if (method === 'GET' && pullMatch) {
      const num = parseInt(pullMatch[1]!, 10);
      try {
        const pr = await this.getPRState(repoName, num);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(pr));
      } catch {
        res.writeHead(404).end(JSON.stringify({ message: 'Not Found' }));
      }
      return;
    }

    res.writeHead(404).end(JSON.stringify({ message: 'Not Found' }));
  }
}
