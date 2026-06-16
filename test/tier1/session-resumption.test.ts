/**
 * Tier 1 tests: Session resumption — kiro_session_id persistence and
 * terminated_by_restart termination reason.
 * Spec: .kiro/specs/operator-controls/ · tasks 3.1
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

let tmpDir: string;
let sf: SessionFiles;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resume-t1-'));
  sf = createSessionFiles(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('kiro_session_id persistence (Task 3.1)', () => {
  it('round-trips kiro_session_id through updateMeta and readMeta', () => {
    sf.createSession('sess-001', 'Fix bug');
    sf.updateMeta('sess-001', { kiro_session_id: 'kiro-abc-123' });

    const meta = sf.readMeta('sess-001');
    expect(meta.kiro_session_id).toBe('kiro-abc-123');
  });

  it('kiro_session_id is optional — absent by default', () => {
    sf.createSession('sess-002', 'Test');
    const meta = sf.readMeta('sess-002');
    expect(meta.kiro_session_id).toBeUndefined();
  });

  it('persists kiro_session_id in JSON on disk', () => {
    sf.createSession('sess-003', 'Test');
    sf.updateMeta('sess-003', { kiro_session_id: 'kiro-xyz' });

    const raw = fs.readFileSync(
      path.join(tmpDir, 'sessions', 'sess-003', 'meta.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['kiro_session_id']).toBe('kiro-xyz');
  });
});

describe('terminated_by_restart reason (Task 3.1)', () => {
  it('accepts terminated_by_restart as a valid termination reason', () => {
    sf.createSession('sess-004', 'Test');
    sf.updateMeta('sess-004', {
      status: 'abandoned',
      completed_at: Math.floor(Date.now() / 1000),
      termination_reason: 'terminated_by_restart',
    });

    const meta = sf.readMeta('sess-004');
    expect(meta.status).toBe('abandoned');
    expect(meta.termination_reason).toBe('terminated_by_restart');
    expect(meta.completed_at).not.toBeNull();
  });

  it('getSessionPaths returns correct paths for existing session', () => {
    sf.createSession('sess-005', 'Test');
    const paths = sf.getSessionPaths('sess-005');
    expect(paths.dir).toBe(path.join(tmpDir, 'sessions', 'sess-005'));
    expect(paths.meta).toBe(path.join(tmpDir, 'sessions', 'sess-005', 'meta.json'));
    expect(paths.stream).toBe(path.join(tmpDir, 'sessions', 'sess-005', 'stream.log'));
    expect(paths.prompts).toBe(path.join(tmpDir, 'sessions', 'sess-005', 'prompts.log'));
  });
});
