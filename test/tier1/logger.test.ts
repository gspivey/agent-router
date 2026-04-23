import { describe, it, expect } from 'vitest';
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
