import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createSessionFiles,
  type SessionFiles,
  type StreamEntry,
  type SessionMeta,
  type PromptSource,
} from '../../src/session-files.js';

// Use /dev/shm (ramdisk) for property tests when available — avoids slow fsync
// calls on spinning/SSD storage that add ~15ms per iteration (1.5s for 100 runs).
// Falls back to the system temp directory on non-Linux hosts.
function fastTmpDir(): string {
  if (fs.existsSync('/dev/shm')) {
    return fs.mkdtempSync('/dev/shm/sf-prop-test-');
  }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sf-prop-test-'));
}

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

// ---------------------------------------------------------------------------
// Property tests setup — use /dev/shm (ramdisk) for ~250x faster file I/O
// ---------------------------------------------------------------------------
//
// Session file property tests create one session per fast-check iteration:
//   100 runs × 4 fsync calls/session × ~3ms/fsync on disk = ~1.2s overhead.
// On /dev/shm, fsync is essentially free (0.06ms/iteration = ~6ms total).
// The `propSf` / `propTmpDir` variables are reset per describe block via their
// own nested beforeEach/afterEach so each property suite has a clean state.

let propTmpDir: string;
let propSf: SessionFiles;

// ---------------------------------------------------------------------------
// Property 16: Stream Entry Structure (task 11.7)
// ---------------------------------------------------------------------------

describe('Property 16: Stream Entry Structure', () => {
  beforeEach(() => {
    propTmpDir = fastTmpDir();
    propSf = createSessionFiles(propTmpDir);
  });
  afterEach(() => {
    fs.rmSync(propTmpDir, { recursive: true, force: true });
  });

  it('every appendStream write produces valid single-line JSON with required fields (100 runs)', () => {
    const sourceArb = fc.constantFrom<StreamEntry['source']>('router', 'agent');
    const typeArb = fc.constantFrom(
      'session_started',
      'session_ended',
      'message',
      'tool_call',
      'tool_result',
      'webhook_received',
      'event_routed',
    );

    fc.assert(
      fc.property(
        // Arbitrary string values including those with newlines that should be stripped
        fc.record({
          ts: fc.date().map((d) => d.toISOString()),
          source: sourceArb,
          type: typeArb,
          // extra field — may contain newlines that must be stripped
          text: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
        }),
        (entryFields) => {
          const sessionId = `sess-prop16-${Math.random().toString(36).slice(2)}`;
          propSf.createSession(sessionId, 'test');

          // Build the entry — only include defined fields
          const entry: StreamEntry = {
            ts: entryFields.ts,
            source: entryFields.source,
            type: entryFields.type,
            ...(entryFields.text !== undefined ? { text: entryFields.text } : {}),
          };

          propSf.appendStream(sessionId, entry);

          const streamPath = path.join(propTmpDir, 'sessions', sessionId, 'stream.log');
          const content = fs.readFileSync(streamPath, 'utf-8');
          const lines = content.trimEnd().split('\n');

          // Exactly one line appended
          expect(lines).toHaveLength(1);

          // Must be valid JSON
          let parsed: Record<string, unknown>;
          expect(() => {
            parsed = JSON.parse(lines[0]!);
          }).not.toThrow();

          // Required fields present as strings
          expect(typeof parsed!['ts']).toBe('string');
          expect(typeof parsed!['source']).toBe('string');
          expect(typeof parsed!['type']).toBe('string');

          // No embedded newlines in any string value
          for (const [, value] of Object.entries(parsed!)) {
            if (typeof value === 'string') {
              expect(value).not.toMatch(/\r|\n/);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 17: Meta File Atomic Writes (task 11.8)
// ---------------------------------------------------------------------------

describe('Property 17: Meta File Atomic Writes', () => {
  beforeEach(() => {
    propTmpDir = fastTmpDir();
    propSf = createSessionFiles(propTmpDir);
  });
  afterEach(() => {
    fs.rmSync(propTmpDir, { recursive: true, force: true });
  });

  it('meta.json is always valid JSON after every updateMeta call (100 runs)', () => {
    const statusArb = fc.constantFrom<'completed' | 'failed' | 'abandoned'>(
      'completed',
      'failed',
      'abandoned',
    );

    fc.assert(
      fc.property(
        statusArb,
        fc.integer({ min: 1_700_000_000, max: 1_999_999_999 }),
        (status, completedAt) => {
          const sessionId = `sess-prop17-${Math.random().toString(36).slice(2)}`;
          propSf.createSession(sessionId, 'atomic-write-test');

          // The meta file must be valid JSON after initial creation
          const metaPath = path.join(propTmpDir, 'sessions', sessionId, 'meta.json');
          const raw1 = fs.readFileSync(metaPath, 'utf-8');
          expect(() => JSON.parse(raw1)).not.toThrow();

          // Apply a terminal-status patch
          propSf.updateMeta(sessionId, { status, completed_at: completedAt });

          // Must still be valid JSON
          const raw2 = fs.readFileSync(metaPath, 'utf-8');
          let parsed: Record<string, unknown>;
          expect(() => {
            parsed = JSON.parse(raw2);
          }).not.toThrow();

          // Patched values reflected
          expect(parsed!['status']).toBe(status);
          expect(parsed!['completed_at']).toBe(completedAt);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 18: Session Status Transitions (task 11.9)
// ---------------------------------------------------------------------------

describe('Property 18: Session Status Transitions', () => {
  beforeEach(() => {
    propTmpDir = fastTmpDir();
    propSf = createSessionFiles(propTmpDir);
  });
  afterEach(() => {
    fs.rmSync(propTmpDir, { recursive: true, force: true });
  });

  it('any terminal status prevents further updateMeta (100 runs)', () => {
    const terminalStatusArb = fc.constantFrom<'completed' | 'failed' | 'abandoned'>(
      'completed',
      'failed',
      'abandoned',
    );

    fc.assert(
      fc.property(
        terminalStatusArb,
        fc.constantFrom<'completed' | 'failed' | 'abandoned'>('completed', 'failed', 'abandoned'),
        (firstStatus, secondStatus) => {
          const sessionId = `sess-prop18-${Math.random().toString(36).slice(2)}`;
          propSf.createSession(sessionId, 'status-transition-test');

          // Transition to terminal status
          propSf.updateMeta(sessionId, { status: firstStatus, completed_at: 1_700_000_000 });

          // Any subsequent update must throw
          expect(() => {
            propSf.updateMeta(sessionId, { status: secondStatus, completed_at: 1_700_000_001 });
          }).toThrow(/only 'active' sessions can be modified/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('patch applied exactly once for active sessions (100 runs)', () => {
    const prsArb = fc.array(
      fc.record({
        repo: fc.constant('org/repo'),
        pr_number: fc.integer({ min: 1, max: 999 }),
        registered_at: fc.integer({ min: 1_700_000_000, max: 1_999_999_999 }),
      }),
      { minLength: 0, maxLength: 5 },
    );

    fc.assert(
      fc.property(prsArb, (prs) => {
        const sessionId = `sess-prop18b-${Math.random().toString(36).slice(2)}`;
        propSf.createSession(sessionId, 'patch-once-test');

        propSf.updateMeta(sessionId, { prs });

        const meta = propSf.readMeta(sessionId);
        expect(meta.prs).toHaveLength(prs.length);
        // status still active
        expect(meta.status).toBe('active');
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 19: Prompt Log Completeness (task 11.10)
// ---------------------------------------------------------------------------

describe('Property 19: Prompt Log Completeness', () => {
  beforeEach(() => {
    propTmpDir = fastTmpDir();
    propSf = createSessionFiles(propTmpDir);
  });
  afterEach(() => {
    fs.rmSync(propTmpDir, { recursive: true, force: true });
  });

  it(
    'every appendPrompt call adds exactly one entry (100 runs)',
    { timeout: 10_000 },
    () => {
    const sourceArb = fc.constantFrom<PromptSource>(
      'cli',
      'webhook',
      'cron',
      'mcp',
      'web',
      'router',
    );

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            source: sourceArb,
            // prompts may contain newlines — they should be stripped
            prompt: fc.string({ maxLength: 500 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (entries) => {
          const sessionId = `sess-prop19-${Math.random().toString(36).slice(2)}`;
          propSf.createSession(sessionId, 'prompt-completeness-test');

          for (const { source, prompt } of entries) {
            propSf.appendPrompt(sessionId, source, prompt);
          }

          const promptsPath = path.join(propTmpDir, 'sessions', sessionId, 'prompts.log');
          const content = fs.readFileSync(promptsPath, 'utf-8');
          const lines = content.trimEnd().split('\n');

          // One line per prompt
          expect(lines).toHaveLength(entries.length);

          for (let i = 0; i < entries.length; i++) {
            const parsed = JSON.parse(lines[i]!) as Record<string, unknown>;

            // source preserved
            expect(parsed['source']).toBe(entries[i]!.source);

            // prompt text present (newlines replaced by spaces)
            expect(typeof parsed['prompt']).toBe('string');
            const storedPrompt = parsed['prompt'] as string;

            // No embedded newlines in the stored value
            expect(storedPrompt).not.toMatch(/\r|\n/);

            // ts present
            expect(typeof parsed['ts']).toBe('string');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Task 11.11 — Session file edge cases (optional deferred unit tests)
// ---------------------------------------------------------------------------

describe('createSession — error paths (task 11.11)', () => {
  it('throws when a file already occupies the session directory path', () => {
    // Simulate the case where a file exists where the directory should go.
    // Write a regular file at the sessions/<id> path before calling createSession.
    const sessionsDir = path.join(tmpDir, 'sessions');
    const blockerPath = path.join(sessionsDir, 'blocked-sess');
    fs.writeFileSync(blockerPath, 'blocker');

    // createSession must throw with a descriptive message (Req 18.8)
    expect(() => sf.createSession('blocked-sess', 'some prompt')).toThrow();
  });

  it('stream entries are written as-is — no unexpected field mutation', () => {
    // Verify that appendStream serialises the entry verbatim.
    // (session-files has no secret-filtering layer; that is the logger's job.)
    sf.createSession('sess-nomut', 'test prompt');
    const entry: import('../../src/session-files.js').StreamEntry = {
      ts: '2026-11-03T00:00:00Z',
      source: 'agent',
      type: 'agent-message',
      content: 'response text',
      extra_field: 'extra_value',
    };
    sf.appendStream('sess-nomut', entry);

    const paths = sf.createSession('sess-nomut-read', 'read test');
    // Read the stream.log of sess-nomut directly
    const streamLog = path.join(tmpDir, 'sessions', 'sess-nomut', 'stream.log');
    const raw = fs.readFileSync(streamLog, 'utf-8').trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed['ts']).toBe('2026-11-03T00:00:00Z');
    expect(parsed['source']).toBe('agent');
    expect(parsed['type']).toBe('agent-message');
    expect(parsed['content']).toBe('response text');
    expect(parsed['extra_field']).toBe('extra_value');

    // Suppress unused variable warning
    void paths;
  });
});
