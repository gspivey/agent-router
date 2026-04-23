/**
 * Tier 2 test: session directory structure and atomic meta updates.
 * Exercises createSessionFiles through the daemon's filesystem layout.
 * Requirements: 18.3, 18.7, 24.6
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createSessionFiles,
  type SessionFiles,
  type SessionMeta,
} from '../../src/session-files.js';

let rootDir: string;
let sf: SessionFiles;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-files-tier2-'));
  sf = createSessionFiles(rootDir);
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('session directory structure (Req 18.3)', () => {
  it('creates the expected filesystem layout for a new session', () => {
    const paths = sf.createSession('abc123', 'Fix the flaky test');

    // Verify directory exists
    const stat = fs.statSync(paths.dir);
    expect(stat.isDirectory()).toBe(true);

    // Verify all three files exist
    expect(fs.existsSync(paths.meta)).toBe(true);
    expect(fs.existsSync(paths.stream)).toBe(true);
    expect(fs.existsSync(paths.prompts)).toBe(true);

    // Verify meta.json content
    const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf-8')) as SessionMeta;
    expect(meta.session_id).toBe('abc123');
    expect(meta.original_prompt).toBe('Fix the flaky test');
    expect(meta.status).toBe('active');
    expect(meta.prs).toEqual([]);
    expect(meta.completed_at).toBeNull();
    expect(typeof meta.created_at).toBe('number');
  });

  it('supports multiple concurrent sessions', () => {
    sf.createSession('session-a', 'prompt a');
    sf.createSession('session-b', 'prompt b');
    sf.createSession('session-c', 'prompt c');

    const sessions = sf.listSessions();
    expect(sessions).toHaveLength(3);

    const ids = sessions.map((s) => s.session_id).sort();
    expect(ids).toEqual(['session-a', 'session-b', 'session-c']);
  });

  it('root directory contains sessions/ and daemon.log', () => {
    expect(fs.existsSync(path.join(rootDir, 'sessions'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'daemon.log'))).toBe(true);
  });
});

describe('atomic meta updates (Req 18.7)', () => {
  it('meta.json is always valid JSON after update', () => {
    sf.createSession('atomic-1', 'test');

    // Perform several updates
    sf.updateMeta('atomic-1', {
      prs: [{ repo: 'org/repo', pr_number: 10, registered_at: 1700000000 }],
    });

    const raw = fs.readFileSync(
      path.join(rootDir, 'sessions', 'atomic-1', 'meta.json'),
      'utf-8',
    );
    const meta = JSON.parse(raw) as SessionMeta;
    expect(meta.prs).toHaveLength(1);
    expect(meta.status).toBe('active');
  });

  it('status transition active → completed is persisted atomically', () => {
    sf.createSession('atomic-2', 'test');
    sf.updateMeta('atomic-2', { status: 'completed', completed_at: 1700000000 });

    // Read directly from disk to verify atomic write
    const raw = fs.readFileSync(
      path.join(rootDir, 'sessions', 'atomic-2', 'meta.json'),
      'utf-8',
    );
    const meta = JSON.parse(raw) as SessionMeta;
    expect(meta.status).toBe('completed');
    expect(meta.completed_at).toBe(1700000000);
  });

  it('status transition active → failed is persisted atomically', () => {
    sf.createSession('atomic-3', 'test');
    sf.updateMeta('atomic-3', { status: 'failed', completed_at: 1700000001 });

    const meta = sf.readMeta('atomic-3');
    expect(meta.status).toBe('failed');
  });

  it('status transition active → abandoned is persisted atomically', () => {
    sf.createSession('atomic-4', 'test');
    sf.updateMeta('atomic-4', { status: 'abandoned', completed_at: 1700000002 });

    const meta = sf.readMeta('atomic-4');
    expect(meta.status).toBe('abandoned');
  });

  it('refuses to update a completed session', () => {
    sf.createSession('atomic-5', 'test');
    sf.updateMeta('atomic-5', { status: 'completed', completed_at: 1700000000 });

    expect(() => {
      sf.updateMeta('atomic-5', { status: 'failed', completed_at: 1700000001 });
    }).toThrow(/only 'active' sessions can be modified/);

    // Verify original state is preserved
    const meta = sf.readMeta('atomic-5');
    expect(meta.status).toBe('completed');
    expect(meta.completed_at).toBe(1700000000);
  });

  it('no temp files left behind after atomic write', () => {
    sf.createSession('atomic-6', 'test');
    sf.updateMeta('atomic-6', { status: 'completed', completed_at: 1700000000 });

    const dirContents = fs.readdirSync(
      path.join(rootDir, 'sessions', 'atomic-6'),
    );
    const tmpFiles = dirContents.filter((f) => f.startsWith('.tmp-'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('full session lifecycle: create → add PR → complete', () => {
    sf.createSession('lifecycle-1', 'Implement feature X');

    // Add a PR
    const meta1 = sf.readMeta('lifecycle-1');
    sf.updateMeta('lifecycle-1', {
      prs: [...meta1.prs, { repo: 'org/repo', pr_number: 42, registered_at: 1700000000 }],
    });

    // Verify PR was added
    const meta2 = sf.readMeta('lifecycle-1');
    expect(meta2.prs).toHaveLength(1);
    expect(meta2.status).toBe('active');

    // Complete the session
    sf.updateMeta('lifecycle-1', { status: 'completed', completed_at: 1700000100 });

    // Verify final state
    const meta3 = sf.readMeta('lifecycle-1');
    expect(meta3.status).toBe('completed');
    expect(meta3.completed_at).toBe(1700000100);
    expect(meta3.prs).toHaveLength(1);
    expect(meta3.original_prompt).toBe('Implement feature X');
  });
});

describe('stream and prompt append durability', () => {
  it('stream entries are flushed and readable immediately', () => {
    const paths = sf.createSession('flush-1', 'test');

    sf.appendStream('flush-1', {
      ts: '2024-01-01T00:00:00.000Z',
      source: 'router',
      type: 'session_started',
    });

    // Read immediately — should be visible
    const content = fs.readFileSync(paths.stream, 'utf-8');
    expect(content.trim()).not.toBe('');
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe('session_started');
  });

  it('prompt entries are flushed and readable immediately', () => {
    const paths = sf.createSession('flush-2', 'test');

    sf.appendPrompt('flush-2', 'webhook', 'CI failed on PR #42');

    const content = fs.readFileSync(paths.prompts, 'utf-8');
    expect(content.trim()).not.toBe('');
    const parsed = JSON.parse(content.trim());
    expect(parsed.source).toBe('webhook');
    expect(parsed.prompt).toBe('CI failed on PR #42');
  });
});
