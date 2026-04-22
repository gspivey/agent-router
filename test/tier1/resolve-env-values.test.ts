import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
