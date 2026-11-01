/**
 * Property tests for config module: resolveEnvValues (task 3.4) and
 * validateConfig (task 3.5).
 *
 * These are optional property tests from `.kiro/specs/agent-router/tasks.md`
 * tasks 3.4 and 3.5, added as part of ROADMAP item 104 (PR: TBD).
 *
 * Property 1: ENV: Value Resolution (Requirements 1.2)
 * Property 12: Configuration Validation (Requirements 15.1–15.4)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveEnvValues } from '../../src/config.js';
import { FatalError } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

function deleteEnv(key: string): void {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear savedEnv for next test
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// Create a temp executable file for kiroPath tests
function createExecutable(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-prop-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'fake-kiro');
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

// ---------------------------------------------------------------------------
// Task 3.4 — Property tests for resolveEnvValues (Property 1)
// ---------------------------------------------------------------------------

describe('resolveEnvValues property tests (task 3.4)', () => {
  /**
   * Property: any plain value (non-ENV: string, number, boolean, null) passes
   * through unchanged.
   */
  it('property: non-ENV: scalar values pass through unchanged', () => {
    fc.assert(
      fc.property(
        // Generate a flat config with a mix of non-ENV: scalar types
        fc.record({
          a: fc.oneof(
            fc.integer(),
            fc.boolean(),
            fc.constant(null),
            // Strings that do NOT start with "ENV:" — could be empty, unicode, etc.
            fc.string().filter((s) => !s.startsWith('ENV:')),
          ),
          b: fc.integer(),
          c: fc.boolean(),
        }),
        (raw) => {
          const result = resolveEnvValues(raw as Record<string, unknown>);
          return (
            result['a'] === raw.a &&
            result['b'] === raw.b &&
            result['c'] === raw.c
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: ENV: values are resolved to the env var's value (after trimming).
   * We set a known env var and verify the resolved value equals the raw env value
   * trimmed.
   */
  it('property: ENV: value resolves to trimmed env var value', () => {
    // Use fc.string of printable chars so we can control the env var content
    fc.assert(
      fc.property(
        // The env var value may have leading/trailing whitespace
        fc.string({ minLength: 1, maxLength: 200 }).map((s) => s + ' '),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[A-Z][A-Z0-9_]*$/.test(s)),
        (rawValue, varSuffix) => {
          const varName = `TEST_PROP_RESOLVE_${varSuffix}`;
          setEnv(varName, rawValue);
          const result = resolveEnvValues({ key: `ENV:${varName}` });
          return result['key'] === rawValue.trim();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: ENV: values resolve to the trimmed version of the env var — both
   * leading and trailing whitespace (including newlines) are stripped.
   */
  it('property: ENV: resolution always trims surrounding whitespace', () => {
    fc.assert(
      fc.property(
        // A base value + surrounding whitespace/newlines
        fc.tuple(
          fc.string({ minLength: 0, maxLength: 100 }),
          fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r')),
          fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r')),
        ),
        ([base, leading, trailing]) => {
          const rawValue = leading + base + trailing;
          const varName = 'TEST_PROP_TRIM_ENVVAL';
          setEnv(varName, rawValue);
          const result = resolveEnvValues({ tok: 'ENV:TEST_PROP_TRIM_ENVVAL' });
          return result['tok'] === rawValue.trim();
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: strings that merely contain "ENV:" but do not start with it are
   * never modified.
   */
  it('property: strings containing but not starting with ENV: pass through', () => {
    fc.assert(
      fc.property(
        // Prefix must be non-empty and not start the string with "ENV:"
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.length > 0 && !s.startsWith('ENV:')),
        fc.string({ minLength: 0, maxLength: 50 }),
        (prefix, suffix) => {
          const s = prefix + 'ENV:' + suffix;
          const result = resolveEnvValues({ val: s });
          return result['val'] === s;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: resolveEnvValues on a nested object resolves ENV: values at any
   * depth.
   */
  it('property: ENV: values are resolved inside nested objects', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        (expectedValue) => {
          const varName = 'TEST_PROP_NESTED';
          setEnv(varName, expectedValue);
          const raw = { outer: { inner: 'ENV:TEST_PROP_NESTED', keep: 42 } };
          const result = resolveEnvValues(raw as Record<string, unknown>);
          const outer = result['outer'] as Record<string, unknown>;
          return outer['inner'] === expectedValue.trim() && outer['keep'] === 42;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: if ENV: references an unset variable, resolveEnvValues always
   * throws a FatalError that mentions the variable name.
   */
  it('property: missing ENV: variable always throws FatalError with var name', () => {
    fc.assert(
      fc.property(
        // Generate a unique-enough suffix to avoid env var collisions
        fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[A-Z]+$/.test(s)),
        (suffix) => {
          const varName = `TEST_PROP_MISSING_${suffix}`;
          deleteEnv(varName);
          try {
            resolveEnvValues({ key: `ENV:${varName}` });
            return false; // should have thrown
          } catch (err) {
            return (
              err instanceof FatalError &&
              (err as FatalError).message.includes(varName)
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Task 3.5 — Property test for validateConfig (Property 12)
// ---------------------------------------------------------------------------

describe('validateConfig property tests (task 3.5)', () => {
  // Lazy import to avoid top-level circular issues
  let validateConfig: (config: unknown) => unknown;

  beforeEach(async () => {
    const mod = await import('../../src/config.js');
    validateConfig = mod.validateConfig;
  });

  /**
   * Property: a config object with a valid port in [1, 65535], a non-empty
   * webhookSecret, a valid kiroPath, and at least one valid repo always passes
   * validation without throwing.
   */
  it('property: valid config always passes validateConfig without throwing', () => {
    // We need to create a real executable once for this property test
    const kiroPath = createExecutable();

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65535 }),
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[a-z0-9-]+$/i.test(s)),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[a-z0-9-]+$/i.test(s)),
        (port, webhookSecret, owner, repoName) => {
          const config = {
            port,
            webhookSecret,
            kiroPath,
            rateLimit: { perPRSeconds: 60 },
            repos: [{ owner, name: repoName }],
            cron: [],
          };
          try {
            validateConfig(config);
            return true;
          } catch {
            return false;
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: a config with port outside [1, 65535] always fails validation.
   */
  it('property: out-of-range port always fails validateConfig', () => {
    const kiroPath = createExecutable();

    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -10000, max: 0 }),
          fc.integer({ min: 65536, max: 100000 }),
        ),
        (port) => {
          const config = {
            port,
            webhookSecret: 'secret',
            kiroPath,
            repos: [{ owner: 'org', name: 'repo' }],
            cron: [],
          };
          try {
            validateConfig(config);
            return false; // should have thrown
          } catch {
            return true;
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: a config with an empty webhookSecret always fails validation.
   */
  it('property: empty webhookSecret always fails validateConfig', () => {
    const kiroPath = createExecutable();

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65535 }),
        (port) => {
          const config = {
            port,
            webhookSecret: '',
            kiroPath,
            repos: [{ owner: 'org', name: 'repo' }],
            cron: [],
          };
          try {
            validateConfig(config);
            return false;
          } catch {
            return true;
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: a config with a repo whose owner is an empty string always fails.
   */
  it('property: config with repo having empty owner always fails validateConfig', () => {
    const kiroPath = createExecutable();

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65535 }),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[a-z0-9-]+$/i.test(s)),
        (port, repoName) => {
          const config = {
            port,
            webhookSecret: 'secret',
            kiroPath,
            repos: [{ owner: '', name: repoName }],
            cron: [],
          };
          try {
            validateConfig(config);
            return false;
          } catch {
            return true;
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: a config with a repo whose name is an empty string always fails.
   */
  it('property: config with repo having empty name always fails validateConfig', () => {
    const kiroPath = createExecutable();

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65535 }),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[a-z0-9-]+$/i.test(s)),
        (port, owner) => {
          const config = {
            port,
            webhookSecret: 'secret',
            kiroPath,
            repos: [{ owner, name: '' }],
            cron: [],
          };
          try {
            validateConfig(config);
            return false;
          } catch {
            return true;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
