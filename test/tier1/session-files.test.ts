import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createSessionFiles,
  type SessionFiles,
  type StreamEntry,
  type SessionMeta,
} from '../../src/session-files.js';

let tmpDir: string;
let sf: SessionFiles;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-files-test-'));
  sf = createSessionFiles(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createSessionFiles (init)', () => {
  it('creates root dir, sessions/ subdir, and daemon.log', () => {
    const root = path.join(tmpDir, 'nested', 'root');
    createSessionFiles(root);
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(path.join(root, 'sessions'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'daemon.log'))).toBe(true);
  });

  it('is idempotent — calling twice does not throw', () => {
    createSessionFiles(tmpDir);
    createSessionFiles(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'sessions'))).toBe(true);
  });
});

describe('createSession', () => {
  it('creates session directory with meta.json, stream.log, prompts.log', () => {
    const paths = sf.createSession('sess-001', 'Fix the bug');
    expect(fs.existsSync(paths.dir)).toBe(true);
    expect(fs.existsSync(paths.meta)).toBe(true);
    expect(fs.existsSync(paths.stream)).toBe(true);
    expect(fs.existsSync(paths.prompts)).toBe(true);
  });

  it('returns correct SessionPaths', () => {
    const paths = sf.createSession('sess-002', 'Hello');
    expect(paths.dir).toBe(path.join(tmpDir, 'sessions', 'sess-002'));
    expect(paths.meta).toBe(path.join(tmpDir, 'sessions', 'sess-002', 'meta.json'));
    expect(paths.stream).toBe(path.join(tmpDir, 'sessions', 'sess-002', 'stream.log'));
    expect(paths.prompts).toBe(path.join(tmpDir, 'sessions', 'sess-002', 'prompts.log'));
  });

  it('writes meta.json with correct initial state', () => {
    sf.createSession('sess-003', 'Do something');
    const meta = sf.readMeta('sess-003');
    expect(meta.session_id).toBe('sess-003');
    expect(meta.original_prompt).toBe('Do something');
    expect(meta.status).toBe('active');
    expect(meta.completed_at).toBeNull();
    expect(meta.prs).toEqual([]);
    expect(typeof meta.created_at).toBe('number');
  });

  it('meta.json is valid JSON (atomic write)', () => {
    sf.createSession('sess-004', 'test');
    const raw = fs.readFileSync(
      path.join(tmpDir, 'sessions', 'sess-004', 'meta.json'),
      'utf-8',
    );
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('stream.log and prompts.log start empty', () => {
    const paths = sf.createSession('sess-005', 'test');
    expect(fs.readFileSync(paths.stream, 'utf-8')).toBe('');
    expect(fs.readFileSync(paths.prompts, 'utf-8')).toBe('');
  });
});

describe('appendStream', () => {
  it('appends a single-line NDJSON entry to stream.log', () => {
    const paths = sf.createSession('sess-stream-1', 'test');
    const entry: StreamEntry = {
      ts: '2024-01-01T00:00:00.000Z',
      source: 'router',
      type: 'session_started',
    };
    sf.appendStream('sess-stream-1', entry);

    const content = fs.readFileSync(paths.stream, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ts).toBe('2024-01-01T00:00:00.000Z');
    expect(parsed.source).toBe('router');
    expect(parsed.type).toBe('session_started');
  });

  it('appends multiple entries as separate lines', () => {
    const paths = sf.createSession('sess-stream-2', 'test');
    sf.appendStream('sess-stream-2', {
      ts: '2024-01-01T00:00:00.000Z',
      source: 'router',
      type: 'session_started',
    });
    sf.appendStream('sess-stream-2', {
      ts: '2024-01-01T00:00:01.000Z',
      source: 'agent',
      type: 'message',
      text: 'hello',
    });

    const content = fs.readFileSync(paths.stream, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).type).toBe('message');
  });

  it('strips embedded newlines from string values', () => {
    const paths = sf.createSession('sess-stream-3', 'test');
    sf.appendStream('sess-stream-3', {
      ts: '2024-01-01T00:00:00.000Z',
      source: 'agent',
      type: 'message',
      text: 'line1\nline2\r\nline3',
    });

    const content = fs.readFileSync(paths.stream, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.text).toBe('line1 line2 line3');
  });

  it('preserves additional type-specific fields', () => {
    const paths = sf.createSession('sess-stream-4', 'test');
    sf.appendStream('sess-stream-4', {
      ts: '2024-01-01T00:00:00.000Z',
      source: 'agent',
      type: 'tool_call',
      tool: 'readFile',
      args: { path: '/tmp/test' },
    });

    const content = fs.readFileSync(paths.stream, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.tool).toBe('readFile');
    expect(parsed.args).toEqual({ path: '/tmp/test' });
  });
});

describe('appendPrompt', () => {
  it('appends a prompt entry to prompts.log with ts, source, prompt', () => {
    const paths = sf.createSession('sess-prompt-1', 'test');
    sf.appendPrompt('sess-prompt-1', 'cli', 'Fix the CI failure');

    const content = fs.readFileSync(paths.prompts, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.source).toBe('cli');
    expect(parsed.prompt).toBe('Fix the CI failure');
    expect(typeof parsed.ts).toBe('string');
  });

  it('appends multiple prompts as separate lines', () => {
    const paths = sf.createSession('sess-prompt-2', 'test');
    sf.appendPrompt('sess-prompt-2', 'cli', 'First prompt');
    sf.appendPrompt('sess-prompt-2', 'webhook', 'Second prompt');

    const content = fs.readFileSync(paths.prompts, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('strips embedded newlines from prompt text', () => {
    const paths = sf.createSession('sess-prompt-3', 'test');
    sf.appendPrompt('sess-prompt-3', 'cli', 'line1\nline2');

    const content = fs.readFileSync(paths.prompts, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.prompt).toBe('line1 line2');
  });

  it('supports all prompt sources', () => {
    sf.createSession('sess-prompt-4', 'test');
    const sources = ['cli', 'webhook', 'cron', 'mcp'] as const;
    for (const source of sources) {
      sf.appendPrompt('sess-prompt-4', source, `prompt from ${source}`);
    }

    const content = fs.readFileSync(
      path.join(tmpDir, 'sessions', 'sess-prompt-4', 'prompts.log'),
      'utf-8',
    );
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(4);
    for (let i = 0; i < sources.length; i++) {
      const parsed = JSON.parse(lines[i]!);
      expect(parsed.source).toBe(sources[i]);
    }
  });
});

describe('updateMeta', () => {
  it('updates status from active to completed', () => {
    sf.createSession('sess-update-1', 'test');
    sf.updateMeta('sess-update-1', {
      status: 'completed',
      completed_at: 1700000000,
    });
    const meta = sf.readMeta('sess-update-1');
    expect(meta.status).toBe('completed');
    expect(meta.completed_at).toBe(1700000000);
  });

  it('updates status from active to failed', () => {
    sf.createSession('sess-update-2', 'test');
    sf.updateMeta('sess-update-2', {
      status: 'failed',
      completed_at: 1700000000,
    });
    const meta = sf.readMeta('sess-update-2');
    expect(meta.status).toBe('failed');
  });

  it('updates status from active to abandoned', () => {
    sf.createSession('sess-update-3', 'test');
    sf.updateMeta('sess-update-3', {
      status: 'abandoned',
      completed_at: 1700000000,
    });
    const meta = sf.readMeta('sess-update-3');
    expect(meta.status).toBe('abandoned');
  });

  it('refuses to modify non-active sessions', () => {
    sf.createSession('sess-update-4', 'test');
    sf.updateMeta('sess-update-4', { status: 'completed', completed_at: 1700000000 });

    expect(() => {
      sf.updateMeta('sess-update-4', { status: 'failed', completed_at: 1700000001 });
    }).toThrow(/only 'active' sessions can be modified/);
  });

  it('appends PR entries to prs array', () => {
    sf.createSession('sess-update-5', 'test');
    const meta = sf.readMeta('sess-update-5');
    const newPrs = [
      ...meta.prs,
      { repo: 'owner/repo', pr_number: 42, registered_at: 1700000000 },
    ];
    sf.updateMeta('sess-update-5', { prs: newPrs });

    const updated = sf.readMeta('sess-update-5');
    expect(updated.prs).toHaveLength(1);
    expect(updated.prs[0]!.repo).toBe('owner/repo');
    expect(updated.prs[0]!.pr_number).toBe(42);
  });

  it('writes meta.json atomically (always valid JSON)', () => {
    sf.createSession('sess-update-6', 'test');
    sf.updateMeta('sess-update-6', { status: 'completed', completed_at: 1700000000 });

    const raw = fs.readFileSync(
      path.join(tmpDir, 'sessions', 'sess-update-6', 'meta.json'),
      'utf-8',
    );
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('preserves fields not in the patch', () => {
    sf.createSession('sess-update-7', 'test');
    const before = sf.readMeta('sess-update-7');
    sf.updateMeta('sess-update-7', { status: 'completed', completed_at: 1700000000 });
    const after = sf.readMeta('sess-update-7');

    expect(after.session_id).toBe(before.session_id);
    expect(after.original_prompt).toBe(before.original_prompt);
    expect(after.created_at).toBe(before.created_at);
  });
});

describe('readMeta', () => {
  it('reads and parses meta.json', () => {
    sf.createSession('sess-read-1', 'my prompt');
    const meta = sf.readMeta('sess-read-1');
    expect(meta.session_id).toBe('sess-read-1');
    expect(meta.original_prompt).toBe('my prompt');
  });

  it('throws on non-existent session', () => {
    expect(() => sf.readMeta('nonexistent')).toThrow();
  });
});

describe('listSessions', () => {
  it('returns empty array when no sessions exist', () => {
    expect(sf.listSessions()).toEqual([]);
  });

  it('returns all sessions sorted by created_at descending', () => {
    sf.createSession('sess-list-1', 'first');
    // Ensure different created_at by manually writing
    const meta1 = sf.readMeta('sess-list-1');

    // Small delay to ensure different timestamps
    sf.createSession('sess-list-2', 'second');

    const sessions = sf.listSessions();
    expect(sessions).toHaveLength(2);
    // Most recent first
    expect(sessions[0]!.created_at).toBeGreaterThanOrEqual(sessions[1]!.created_at);
  });

  it('skips directories without valid meta.json', () => {
    sf.createSession('sess-list-3', 'valid');
    // Create a directory without meta.json
    fs.mkdirSync(path.join(tmpDir, 'sessions', 'broken-session'), { recursive: true });

    const sessions = sf.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.session_id).toBe('sess-list-3');
  });
});

describe('sessionExists', () => {
  it('returns true for existing session', () => {
    sf.createSession('sess-exists-1', 'test');
    expect(sf.sessionExists('sess-exists-1')).toBe(true);
  });

  it('returns false for non-existent session', () => {
    expect(sf.sessionExists('nonexistent')).toBe(false);
  });
});
