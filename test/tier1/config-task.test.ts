import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../../src/config.js';
import { FatalError } from '../../src/errors.js';

/**
 * Tier 1 tests for the task-attempt-outcome config additions (task 9.2):
 * per-repo `concurrency`/`circuitBreaker`, top-level `idleTimeoutSeconds`,
 * `setupTimeoutSeconds`, `taskTranscript`, and `roadmap`. Covers defaults,
 * accepted overrides, and type/range rejection.
 */

const tempDirs: string[] = [];

function createExecutable(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-task-'));
  const filePath = path.join(dir, 'fake-kiro');
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(filePath, 0o755);
  tempDirs.push(dir);
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    port: 3000,
    webhookSecret: 'test-secret',
    kiroPath: createExecutable(),
    repos: [{ owner: 'myorg', name: 'myrepo' }],
    cron: [],
    ...overrides,
  };
}

describe('validateConfig — task-attempt-outcome additions', () => {
  describe('defaults', () => {
    it('applies defaults when the new fields are absent', () => {
      const result = validateConfig(validConfig());
      expect(result.idleTimeoutSeconds).toBe(900);
      expect(result.setupTimeoutSeconds).toBe(120);
      expect(result.taskTranscript).toEqual({
        archiveGraceMinutes: 60,
        retentionDays: 90,
        sweepIntervalMinutes: 30,
      });
      expect(result.roadmap).toEqual({ scanIntervalMinutes: 15 });
      // Per-repo defaults are left undefined on the RepoConfig; the scheduler
      // supplies concurrency=1 / threshold=3 / timeout=3600.
      expect(result.repos[0]!.concurrency).toBeUndefined();
      expect(result.repos[0]!.circuitBreaker).toBeUndefined();
    });
  });

  describe('per-repo concurrency', () => {
    it('accepts a positive integer', () => {
      const result = validateConfig(
        validConfig({ repos: [{ owner: 'o', name: 'r', concurrency: 3 }] })
      );
      expect(result.repos[0]!.concurrency).toBe(3);
    });

    it('rejects a non-integer', () => {
      expect(() =>
        validateConfig(validConfig({ repos: [{ owner: 'o', name: 'r', concurrency: 1.5 }] }))
      ).toThrow(FatalError);
    });

    it('rejects zero / negative', () => {
      expect(() =>
        validateConfig(validConfig({ repos: [{ owner: 'o', name: 'r', concurrency: 0 }] }))
      ).toThrow(FatalError);
    });
  });

  describe('per-repo circuitBreaker', () => {
    it('accepts failureThreshold with default timeoutSeconds', () => {
      const result = validateConfig(
        validConfig({ repos: [{ owner: 'o', name: 'r', circuitBreaker: { failureThreshold: 5 } }] })
      );
      expect(result.repos[0]!.circuitBreaker).toEqual({ failureThreshold: 5, timeoutSeconds: 3600 });
    });

    it('accepts an explicit timeoutSeconds', () => {
      const result = validateConfig(
        validConfig({
          repos: [{ owner: 'o', name: 'r', circuitBreaker: { failureThreshold: 2, timeoutSeconds: 60 } }],
        })
      );
      expect(result.repos[0]!.circuitBreaker).toEqual({ failureThreshold: 2, timeoutSeconds: 60 });
    });

    it('rejects a missing failureThreshold', () => {
      expect(() =>
        validateConfig(validConfig({ repos: [{ owner: 'o', name: 'r', circuitBreaker: {} }] }))
      ).toThrow(FatalError);
    });

    it('rejects a non-object circuitBreaker', () => {
      expect(() =>
        validateConfig(validConfig({ repos: [{ owner: 'o', name: 'r', circuitBreaker: 3 }] }))
      ).toThrow(FatalError);
    });

    it('rejects a non-positive timeoutSeconds', () => {
      expect(() =>
        validateConfig(
          validConfig({
            repos: [{ owner: 'o', name: 'r', circuitBreaker: { failureThreshold: 1, timeoutSeconds: 0 } }],
          })
        )
      ).toThrow(FatalError);
    });
  });

  describe('idleTimeoutSeconds', () => {
    it('accepts a positive integer', () => {
      expect(validateConfig(validConfig({ idleTimeoutSeconds: 300 })).idleTimeoutSeconds).toBe(300);
    });
    it('rejects a non-positive integer', () => {
      expect(() => validateConfig(validConfig({ idleTimeoutSeconds: 0 }))).toThrow(FatalError);
    });
    it('rejects a non-integer', () => {
      expect(() => validateConfig(validConfig({ idleTimeoutSeconds: 1.2 }))).toThrow(FatalError);
    });
  });

  describe('setupTimeoutSeconds', () => {
    it('accepts a positive integer', () => {
      expect(validateConfig(validConfig({ setupTimeoutSeconds: 240 })).setupTimeoutSeconds).toBe(240);
    });
    it('rejects a non-positive integer', () => {
      expect(() => validateConfig(validConfig({ setupTimeoutSeconds: -1 }))).toThrow(FatalError);
    });
  });

  describe('taskTranscript', () => {
    it('accepts partial overrides and fills the rest with defaults', () => {
      const result = validateConfig(validConfig({ taskTranscript: { retentionDays: 30 } }));
      expect(result.taskTranscript).toEqual({
        archiveGraceMinutes: 60,
        retentionDays: 30,
        sweepIntervalMinutes: 30,
      });
    });
    it('rejects a non-object', () => {
      expect(() => validateConfig(validConfig({ taskTranscript: 5 }))).toThrow(FatalError);
    });
    it('rejects a non-positive archiveGraceMinutes', () => {
      expect(() =>
        validateConfig(validConfig({ taskTranscript: { archiveGraceMinutes: 0 } }))
      ).toThrow(FatalError);
    });
    it('rejects a non-integer retentionDays', () => {
      expect(() =>
        validateConfig(validConfig({ taskTranscript: { retentionDays: 1.5 } }))
      ).toThrow(FatalError);
    });
  });

  describe('roadmap', () => {
    it('accepts an override', () => {
      expect(validateConfig(validConfig({ roadmap: { scanIntervalMinutes: 5 } })).roadmap).toEqual({
        scanIntervalMinutes: 5,
      });
    });
    it('rejects a non-object', () => {
      expect(() => validateConfig(validConfig({ roadmap: 'nope' }))).toThrow(FatalError);
    });
    it('rejects a non-positive scanIntervalMinutes', () => {
      expect(() => validateConfig(validConfig({ roadmap: { scanIntervalMinutes: 0 } }))).toThrow(
        FatalError
      );
    });
  });
});
