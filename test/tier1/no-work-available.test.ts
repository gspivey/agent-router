/**
 * Tier 1 tests: no_work_available termination reason can be written and read
 * via session-files.
 * Spec: BACKLOG.md § P1.2
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createSessionFiles, type SessionFiles } from '../../src/session-files.js';

let tmpDir: string;
let sf: SessionFiles;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-work-available-t1-'));
  sf = createSessionFiles(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('no_work_available termination reason (BACKLOG P1.2)', () => {
  it('can be written to meta.json via updateMeta', () => {
    sf.createSession('sess-nwa-1', 'Check roadmap');
    sf.updateMeta('sess-nwa-1', {
      status: 'completed',
      completed_at: 1000,
      termination_reason: 'no_work_available',
    });
    const meta = sf.readMeta('sess-nwa-1');
    expect(meta.status).toBe('completed');
    expect(meta.termination_reason).toBe('no_work_available');
    expect(meta.completed_at).toBe(1000);
  });

  it('persists correctly through JSON serialization round-trip', () => {
    sf.createSession('sess-nwa-2', 'No items left');
    sf.updateMeta('sess-nwa-2', {
      status: 'completed',
      completed_at: 2000,
      termination_reason: 'no_work_available',
    });

    // Read raw file to confirm JSON on disk
    const metaPath = path.join(tmpDir, 'sessions', 'sess-nwa-2', 'meta.json');
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(raw['termination_reason']).toBe('no_work_available');
  });

  it('appears in listSessions results', () => {
    sf.createSession('sess-nwa-3', 'List test');
    sf.updateMeta('sess-nwa-3', {
      status: 'completed',
      completed_at: 3000,
      termination_reason: 'no_work_available',
    });
    const sessions = sf.listSessions();
    const found = sessions.find((s) => s.session_id === 'sess-nwa-3');
    expect(found).toBeDefined();
    expect(found!.termination_reason).toBe('no_work_available');
  });
});
