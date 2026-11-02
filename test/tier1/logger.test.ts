import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { createLogger } from '../../src/log.js';

function capture(): { lines: string[]; output: (line: string) => void } {
  const lines: string[] = [];
  return { lines, output: (line: string) => { lines.push(line); } };
}

function parseLine(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('createLogger', () => {
  describe('log entry structure', () => {
    it('includes timestamp, level, and message', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      log.info('hello world');

      expect(lines).toHaveLength(1);
      const entry = parseLine(lines[0]!);
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('level', 'info');
      expect(entry).toHaveProperty('message', 'hello world');
    });

    it('writes NDJSON (each line ends with newline)', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      log.info('one');
      log.warn('two');

      for (const line of lines) {
        expect(line.endsWith('\n')).toBe(true);
        // Should be valid JSON without the trailing newline
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('includes additional fields passed at call site', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      log.info('event', { repo: 'owner/repo', pr_number: 42 });

      const entry = parseLine(lines[0]!);
      expect(entry['repo']).toBe('owner/repo');
      expect(entry['pr_number']).toBe(42);
    });
  });

  describe('timestamp format', () => {
    it('produces ISO 8601 UTC timestamps', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      log.info('test');

      const entry = parseLine(lines[0]!);
      const ts = entry['timestamp'] as string;
      // ISO 8601 UTC ends with Z
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      // Should parse to a valid date
      expect(new Date(ts).toISOString()).toBe(ts);
    });
  });

  describe('child() field inheritance', () => {
    it('merges parent fields into child log entries', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      const child = log.child({ session_id: 'abc123' });
      child.info('session started');

      const entry = parseLine(lines[0]!);
      expect(entry['session_id']).toBe('abc123');
      expect(entry['message']).toBe('session started');
    });

    it('call-site fields override parent fields', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      const child = log.child({ component: 'router' });
      child.info('override', { component: 'server' });

      const entry = parseLine(lines[0]!);
      expect(entry['component']).toBe('server');
    });

    it('supports nested child() calls', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      const child1 = log.child({ a: 1 });
      const child2 = child1.child({ b: 2 });
      child2.info('nested');

      const entry = parseLine(lines[0]!);
      expect(entry['a']).toBe(1);
      expect(entry['b']).toBe(2);
    });

    it('does not affect parent logger', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      log.child({ extra: true });
      log.info('parent');

      const entry = parseLine(lines[0]!);
      expect(entry).not.toHaveProperty('extra');
    });
  });

  describe('level filtering', () => {
    it('defaults to info level', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      log.debug('should not appear');
      log.info('should appear');

      expect(lines).toHaveLength(1);
      expect(parseLine(lines[0]!)['level']).toBe('info');
    });

    it('filters debug messages at info level', () => {
      const { lines, output } = capture();
      const log = createLogger({ level: 'info', output });
      log.debug('hidden');
      expect(lines).toHaveLength(0);
    });

    it('shows all messages at debug level', () => {
      const { lines, output } = capture();
      const log = createLogger({ level: 'debug', output });
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      expect(lines).toHaveLength(4);
    });

    it('only shows error at error level', () => {
      const { lines, output } = capture();
      const log = createLogger({ level: 'error', output });
      log.debug('no');
      log.info('no');
      log.warn('no');
      log.error('yes');
      expect(lines).toHaveLength(1);
      expect(parseLine(lines[0]!)['level']).toBe('error');
    });

    it('shows warn and error at warn level', () => {
      const { lines, output } = capture();
      const log = createLogger({ level: 'warn', output });
      log.debug('no');
      log.info('no');
      log.warn('yes');
      log.error('yes');
      expect(lines).toHaveLength(2);
    });

    it('falls back to info for invalid LOG_LEVEL', () => {
      const { lines, output } = capture();
      const log = createLogger({ level: 'bogus', output });
      log.debug('hidden');
      log.info('visible');
      expect(lines).toHaveLength(1);
    });
  });

  describe('secret filtering', () => {
    it('redacts secret values from log output', () => {
      const { lines, output } = capture();
      const log = createLogger({ secrets: ['my-super-secret'], output });
      log.info('webhook received', { secret: 'my-super-secret' });

      const raw = lines[0]!;
      expect(raw).not.toContain('my-super-secret');
      expect(raw).toContain('[REDACTED]');
    });

    it('redacts secrets appearing in message text', () => {
      const { lines, output } = capture();
      const log = createLogger({ secrets: ['s3cret'], output });
      log.info('the value is s3cret here');

      expect(lines[0]).not.toContain('s3cret');
      expect(lines[0]).toContain('[REDACTED]');
    });

    it('redacts multiple different secrets', () => {
      const { lines, output } = capture();
      const log = createLogger({ secrets: ['alpha', 'bravo'], output });
      log.info('alpha and bravo');

      const raw = lines[0]!;
      expect(raw).not.toContain('alpha');
      expect(raw).not.toContain('bravo');
    });

    it('redacts ghp_ token patterns', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      log.info('token', { token: 'ghp_abc123DEF456' });

      expect(lines[0]).not.toContain('ghp_abc123DEF456');
      expect(lines[0]).toContain('[REDACTED]');
    });

    it('redacts ghs_ token patterns', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      log.info('token', { token: 'ghs_installToken99' });

      expect(lines[0]).not.toContain('ghs_installToken99');
      expect(lines[0]).toContain('[REDACTED]');
    });

    it('redacts github_pat_ token patterns', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      log.info('token', { token: 'github_pat_longTokenValue123' });

      expect(lines[0]).not.toContain('github_pat_longTokenValue123');
      expect(lines[0]).toContain('[REDACTED]');
    });

    it('redacts common patterns even without explicit secrets list', () => {
      const { lines, output } = capture();
      const log = createLogger({ output });
      log.info('found ghp_testToken in config');

      expect(lines[0]).not.toContain('ghp_testToken');
    });

    it('child logger inherits secret filtering', () => {
      const { lines, output } = capture();
      const log = createLogger({ secrets: ['topsecret'], output });
      const child = log.child({ component: 'router' });
      child.info('value is topsecret');

      expect(lines[0]).not.toContain('topsecret');
      expect(lines[0]).toContain('[REDACTED]');
    });
  });
});

// ── Property tests for logger (spec tasks 4.3, 4.4, 4.5) ──

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

// Numeric rank for level comparison
function levelRank(level: string): number {
  const ranks: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  return ranks[level] ?? 1;
}

describe('property: log entry structure (4.3)', () => {
  it('every emitted line is valid JSON with timestamp, level, and message', () => {
    fc.assert(
      fc.property(
        fc.oneof(...LOG_LEVELS.map((l) => fc.constant(l))) as fc.Arbitrary<LogLevel>,
        fc.string({ minLength: 0, maxLength: 200 }),
        (level, message) => {
          const lines: string[] = [];
          const log = createLogger({ level: 'debug', output: (l: string) => { lines.push(l); } });
          if (level === 'debug') log.debug(message);
          else if (level === 'info') log.info(message);
          else if (level === 'warn') log.warn(message);
          else log.error(message);

          expect(lines).toHaveLength(1);
          const raw = lines[0]!;
          // Must be valid JSON
          let entry: Record<string, unknown>;
          expect(() => { entry = JSON.parse(raw) as Record<string, unknown>; }).not.toThrow();
          entry = JSON.parse(raw) as Record<string, unknown>;
          // Required fields
          expect(typeof entry['timestamp']).toBe('string');
          expect(entry['level']).toBe(level);
          expect(entry['message']).toBe(message);
          // Timestamp must be ISO 8601 UTC
          const ts = entry['timestamp'] as string;
          expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('extra call-site fields appear in the serialized entry', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[a-z_][a-z0-9_]*$/.test(s) && !['timestamp', 'level', 'message'].includes(s)),
        fc.oneof(fc.string({ maxLength: 50 }), fc.integer({ min: 0, max: 9999 })),
        (fieldName, fieldValue) => {
          const lines: string[] = [];
          const log = createLogger({ output: (l: string) => { lines.push(l); } });
          log.info('test', { [fieldName]: fieldValue });
          const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
          expect(entry[fieldName]).toEqual(fieldValue);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('property: no secrets in log output (4.4)', () => {
  it('registered secret never appears in serialized log output', () => {
    fc.assert(
      fc.property(
        // Generate secrets that won't be transformed by JSON serialization (no backslash, double-quote, or control chars).
        // This matches the real use-case: PATs and webhook secrets are printable ASCII without JSON metacharacters.
        fc.string({ minLength: 8, maxLength: 40 }).filter(
          (s) =>
            s.length > 0 &&
            !s.startsWith('ghp_') &&
            !s.startsWith('ghs_') &&
            !s.startsWith('github_pat_') &&
            !/[\\"'\x00-\x1f\x7f]/.test(s),
        ),
        fc.string({ minLength: 0, maxLength: 100 }).filter((s) => !/[\\"'\x00-\x1f\x7f]/.test(s)),
        (secret, message) => {
          const lines: string[] = [];
          const log = createLogger({ secrets: [secret], output: (l: string) => { lines.push(l); } });
          // Log the secret in various positions
          log.info(message.includes(secret) ? message : `${message} ${secret}`, { secretField: secret });
          for (const line of lines) {
            expect(line).not.toContain(secret);
            expect(line).toContain('[REDACTED]');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('secret appearing in a nested field is still redacted', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 8, maxLength: 30 }).filter(
          (s) => !s.startsWith('ghp_') && !s.startsWith('ghs_') && !s.startsWith('github_pat_') && !/[\\"'\x00-\x1f\x7f]/.test(s),
        ),
        (secret) => {
          const lines: string[] = [];
          const log = createLogger({ secrets: [secret], output: (l: string) => { lines.push(l); } });
          log.info('msg', { outer: { inner: secret } });
          expect(lines[0]).not.toContain(secret);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('property: log level filtering (4.5)', () => {
  it('no entry below the configured level is emitted', () => {
    fc.assert(
      fc.property(
        fc.oneof(...LOG_LEVELS.map((l) => fc.constant(l))) as fc.Arbitrary<LogLevel>,
        fc.oneof(...LOG_LEVELS.map((l) => fc.constant(l))) as fc.Arbitrary<LogLevel>,
        (configuredLevel, callLevel) => {
          const lines: string[] = [];
          const log = createLogger({ level: configuredLevel, output: (l: string) => { lines.push(l); } });
          if (callLevel === 'debug') log.debug('msg');
          else if (callLevel === 'info') log.info('msg');
          else if (callLevel === 'warn') log.warn('msg');
          else log.error('msg');

          const shouldEmit = levelRank(callLevel) >= levelRank(configuredLevel);
          if (shouldEmit) {
            expect(lines).toHaveLength(1);
          } else {
            expect(lines).toHaveLength(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('when level is at or above configured level exactly one line is emitted', () => {
    fc.assert(
      fc.property(
        fc.oneof(...LOG_LEVELS.map((l) => fc.constant(l))) as fc.Arbitrary<LogLevel>,
        (configuredLevel) => {
          // Log at each level that should pass through
          const passing = LOG_LEVELS.filter((l) => levelRank(l) >= levelRank(configuredLevel));
          for (const level of passing) {
            const lines: string[] = [];
            const log = createLogger({ level: configuredLevel, output: (l: string) => { lines.push(l); } });
            if (level === 'debug') log.debug('msg');
            else if (level === 'info') log.info('msg');
            else if (level === 'warn') log.warn('msg');
            else log.error('msg');
            expect(lines).toHaveLength(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
