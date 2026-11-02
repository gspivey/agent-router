import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { resolveEnvValues } from '../../src/config.js';
import { FatalError } from '../../src/errors.js';

describe('resolveEnvValues', () => {
  const savedEnv: Record<string, string | undefined> = {};

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
  });

  it('returns an empty object for empty input', () => {
    expect(resolveEnvValues({})).toEqual({});
  });

  it('passes through non-ENV: string values unchanged', () => {
    const raw = { port: 3000, name: 'hello', flag: true, nothing: null };
    expect(resolveEnvValues(raw)).toEqual(raw);
  });

  it('resolves a top-level ENV: value from process.env', () => {
    setEnv('MY_SECRET', 'super-secret');
    const result = resolveEnvValues({ webhookSecret: 'ENV:MY_SECRET' });
    expect(result.webhookSecret).toBe('super-secret');
  });

  it('throws FatalError when the referenced env var is not set', () => {
    deleteEnv('MISSING_VAR');
    expect(() => resolveEnvValues({ key: 'ENV:MISSING_VAR' })).toThrow(FatalError);
    expect(() => resolveEnvValues({ key: 'ENV:MISSING_VAR' })).toThrow('MISSING_VAR');
  });

  it('recursively resolves ENV: values in nested objects', () => {
    setEnv('NESTED_VAL', 'found-it');
    const raw = { outer: { inner: 'ENV:NESTED_VAL', keep: 42 } };
    const result = resolveEnvValues(raw);
    expect(result).toEqual({ outer: { inner: 'found-it', keep: 42 } });
  });

  it('recursively resolves ENV: values inside arrays of objects', () => {
    setEnv('REPO_TOKEN', 'tok-123');
    const raw = {
      repos: [
        { name: 'myrepo', token: 'ENV:REPO_TOKEN' },
        { name: 'other', token: 'literal' },
      ],
    };
    const result = resolveEnvValues(raw);
    expect(result).toEqual({
      repos: [
        { name: 'myrepo', token: 'tok-123' },
        { name: 'other', token: 'literal' },
      ],
    });
  });

  it('leaves non-object array items unchanged', () => {
    const raw = { tags: ['a', 'b', 123, true] };
    expect(resolveEnvValues(raw)).toEqual(raw);
  });

  it('does not resolve strings that merely contain ENV: but do not start with it', () => {
    const raw = { note: 'use ENV:FOO for config' };
    expect(resolveEnvValues(raw)).toEqual(raw);
  });

  it('resolves ENV: with an empty-string env var value', () => {
    setEnv('EMPTY_VAR', '');
    const result = resolveEnvValues({ val: 'ENV:EMPTY_VAR' });
    expect(result.val).toBe('');
  });

  it('trims surrounding whitespace from resolved env values', () => {
    setEnv('PADDED_TOKEN', '  ghp_abc123\n');
    const result = resolveEnvValues({ token: 'ENV:PADDED_TOKEN' });
    expect(result.token).toBe('ghp_abc123');
  });

  it('trims a trailing newline typical of systemd EnvironmentFile', () => {
    setEnv('GITHUB_TOKEN_TEST', 'ghp_realtoken\n');
    const result = resolveEnvValues({ webhookSecret: 'ENV:GITHUB_TOKEN_TEST' });
    expect(result.webhookSecret).toBe('ghp_realtoken');
  });

  it('includes the missing variable name in the FatalError message', () => {
    deleteEnv('XYZ_MISSING');
    try {
      resolveEnvValues({ secret: 'ENV:XYZ_MISSING' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FatalError);
      expect((err as FatalError).message).toContain('XYZ_MISSING');
    }
  });
});

// ---------------------------------------------------------------------------
// Property 1: ENV: value resolution (spec task 3.4)
// ---------------------------------------------------------------------------

describe('Property 1: ENV: value resolution', () => {
  // We use a fixed test-namespace prefix to avoid collision with real env vars
  const TEST_PREFIX = 'AGENT_ROUTER_PROP_TEST_';

  // Clean up any test env vars after each test
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(TEST_PREFIX)) {
        delete process.env[key];
      }
    }
  });

  it('Property 1.1: plain string values pass through unchanged', () => {
    // For any string that does NOT start with "ENV:", the value is unchanged
    const nonEnvString = fc.string({ minLength: 0, maxLength: 100 }).filter(
      (s) => !s.startsWith('ENV:'),
    );
    // Avoid prototype-polluting keys (__proto__, constructor, prototype) which
    // behave differently when used as object keys via computed property syntax
    const safeKey = fc.string({ minLength: 1, maxLength: 20 })
      .filter((k) => /^[a-z_][a-z0-9_]*$/i.test(k))
      .filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype');
    fc.assert(
      fc.property(
        safeKey,
        nonEnvString,
        (key, value) => {
          const result = resolveEnvValues({ [key]: value });
          return (result as Record<string, unknown>)[key] === value;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 1.2: ENV: prefixed values resolve to process.env value (trimmed)', () => {
    // Generate unique variable names using a counter to avoid collisions between runs
    let counter = 0;
    fc.assert(
      fc.property(
        // Env var value (arbitrary printable string, possibly with surrounding whitespace)
        fc.string({ minLength: 0, maxLength: 80 }),
        (rawEnvValue) => {
          const varName = `${TEST_PREFIX}P1_${counter++}`;
          process.env[varName] = rawEnvValue;
          try {
            const result = resolveEnvValues({ key: `ENV:${varName}` });
            const resolved = (result as Record<string, unknown>)['key'];
            // Resolved value must be the trimmed env var value
            return resolved === rawEnvValue.trim();
          } finally {
            delete process.env[varName];
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 1.3: non-ENV: strings survive nested objects unchanged', () => {
    const nonEnvString = fc.string({ minLength: 0, maxLength: 50 }).filter(
      (s) => !s.startsWith('ENV:'),
    );
    const safeKey = fc.string({ minLength: 1, maxLength: 15 })
      .filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k))
      .filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype');
    fc.assert(
      fc.property(
        safeKey,
        safeKey,
        nonEnvString,
        (outerKey, innerKey, value) => {
          // Skip if keys collide — they'd overwrite each other in the record
          if (outerKey === innerKey) return true;
          const input = { [outerKey]: { [innerKey]: value } };
          const result = resolveEnvValues(input) as Record<string, Record<string, unknown>>;
          return result[outerKey]?.[innerKey] === value;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 1.4: after resolution, no ENV: strings remain when all vars are set', () => {
    // Build a flat object with a mix of ENV: and plain values; ensure all referenced vars are set
    let counter = 0;
    fc.assert(
      fc.property(
        // Between 1 and 5 ENV: entries
        fc.array(
          fc.tuple(
            fc.string({ minLength: 1, maxLength: 15 }).filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)).filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype'),
            fc.string({ minLength: 0, maxLength: 40 }), // env var value
          ),
          { minLength: 1, maxLength: 5 },
        ),
        // Some plain-value entries
        fc.array(
          fc.tuple(
            fc.string({ minLength: 1, maxLength: 15 }).filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)).filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype'),
            fc.string({ minLength: 0, maxLength: 40 }).filter((s) => !s.startsWith('ENV:')),
          ),
          { minLength: 0, maxLength: 5 },
        ),
        (envEntries, plainEntries) => {
          const varNames: string[] = [];
          const input: Record<string, string> = {};

          // Set all ENV: entries in process.env using unique names
          for (const [key, val] of envEntries) {
            const varName = `${TEST_PREFIX}P1I_${counter++}`;
            process.env[varName] = val;
            varNames.push(varName);
            input[key] = `ENV:${varName}`;
          }

          for (const [key, val] of plainEntries) {
            // Avoid overwriting ENV: keys if same key appears in both arrays
            if (!(key in input)) {
              input[key] = val;
            }
          }

          try {
            const result = resolveEnvValues(input) as Record<string, unknown>;
            // Invariant: no remaining ENV: strings
            const hasEnvStrings = Object.values(result).some(
              (v) => typeof v === 'string' && v.startsWith('ENV:'),
            );
            return !hasEnvStrings;
          } finally {
            for (const varName of varNames) {
              delete process.env[varName];
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
