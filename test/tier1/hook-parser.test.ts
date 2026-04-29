/**
 * Tier 1 tests: Hook event parser for postToolUse merge detection.
 *
 * Tests parseHookEvent, detectMergeCompletion, and checkHookEventForCompletion
 * as pure functions with no external dependencies.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  parseHookEvent,
  detectMergeCompletion,
  checkHookEventForCompletion,
  type HookEvent,
} from '../../src/hook-parser.js';

describe('parseHookEvent', () => {
  it('parses shape 1: { input: { command }, output: { exitCode } }', () => {
    const json = JSON.stringify({
      input: { command: 'gh pr merge 42' },
      output: { exitCode: 0 },
    });
    const result = parseHookEvent(json);
    expect(result).toEqual({ command: 'gh pr merge 42', exitCode: 0 });
  });

  it('parses shape 2: { command, exitCode }', () => {
    const json = JSON.stringify({
      command: 'gh pr merge --squash',
      exitCode: 0,
    });
    const result = parseHookEvent(json);
    expect(result).toEqual({ command: 'gh pr merge --squash', exitCode: 0 });
  });

  it('parses shape 3: { toolInput: { command }, toolOutput: { exitCode } }', () => {
    const json = JSON.stringify({
      toolInput: { command: 'gh pr merge 42 --squash' },
      toolOutput: { exitCode: 0 },
    });
    const result = parseHookEvent(json);
    expect(result).toEqual({ command: 'gh pr merge 42 --squash', exitCode: 0 });
  });

  it('returns null for invalid JSON', () => {
    expect(parseHookEvent('not json')).toBeNull();
  });

  it('returns null for array', () => {
    expect(parseHookEvent('[]')).toBeNull();
  });

  it('returns null for string', () => {
    expect(parseHookEvent('"hello"')).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseHookEvent('null')).toBeNull();
  });

  it('returns null when command is missing', () => {
    const json = JSON.stringify({ output: { exitCode: 0 } });
    expect(parseHookEvent(json)).toBeNull();
  });

  it('returns null when exitCode is missing', () => {
    const json = JSON.stringify({ input: { command: 'ls' } });
    expect(parseHookEvent(json)).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(parseHookEvent('{}')).toBeNull();
  });

  it('handles non-zero exit codes', () => {
    const json = JSON.stringify({
      input: { command: 'gh pr merge 42' },
      output: { exitCode: 1 },
    });
    const result = parseHookEvent(json);
    expect(result).toEqual({ command: 'gh pr merge 42', exitCode: 1 });
  });

  // Property: any valid JSON object with command string and exitCode number parses successfully
  it('parses any object with command and exitCode (property)', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer(),
        (command, exitCode) => {
          const json = JSON.stringify({ command, exitCode });
          const result = parseHookEvent(json);
          expect(result).toEqual({ command, exitCode });
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('detectMergeCompletion', () => {
  it('detects simple gh pr merge', () => {
    const result = detectMergeCompletion({ command: 'gh pr merge 42', exitCode: 0 });
    expect(result).toEqual({ shouldComplete: true, reason: 'merged' });
  });

  it('detects gh pr merge with --squash flag', () => {
    const result = detectMergeCompletion({ command: 'gh pr merge 42 --squash', exitCode: 0 });
    expect(result).toEqual({ shouldComplete: true, reason: 'merged' });
  });

  it('detects gh pr merge with --squash --delete-branch', () => {
    const result = detectMergeCompletion({
      command: 'gh pr merge 42 --squash --delete-branch',
      exitCode: 0,
    });
    expect(result).toEqual({ shouldComplete: true, reason: 'merged' });
  });

  it('detects gh pr merge without PR number', () => {
    const result = detectMergeCompletion({ command: 'gh pr merge --squash', exitCode: 0 });
    expect(result).toEqual({ shouldComplete: true, reason: 'merged' });
  });

  it('rejects gh pr merge with non-zero exit code', () => {
    const result = detectMergeCompletion({ command: 'gh pr merge 42', exitCode: 1 });
    expect(result).toEqual({ shouldComplete: false, reason: 'merged' });
  });

  it('rejects unrelated commands', () => {
    const result = detectMergeCompletion({ command: 'cargo build', exitCode: 0 });
    expect(result).toEqual({ shouldComplete: false, reason: 'merged' });
  });

  it('rejects gh pr comment (not merge)', () => {
    const result = detectMergeCompletion({ command: 'gh pr comment 42 --body "done"', exitCode: 0 });
    expect(result).toEqual({ shouldComplete: false, reason: 'merged' });
  });

  it('rejects gh pr view (not merge)', () => {
    const result = detectMergeCompletion({ command: 'gh pr view 42', exitCode: 0 });
    expect(result).toEqual({ shouldComplete: false, reason: 'merged' });
  });

  it('detects gh pr merge in a piped command', () => {
    const result = detectMergeCompletion({
      command: 'gh pr merge 42 --squash && echo done',
      exitCode: 0,
    });
    expect(result).toEqual({ shouldComplete: true, reason: 'merged' });
  });

  it('detects gh pr merge with extra whitespace', () => {
    const result = detectMergeCompletion({ command: 'gh  pr  merge 42', exitCode: 0 });
    expect(result).toEqual({ shouldComplete: true, reason: 'merged' });
  });

  // Property: non-zero exit code never triggers completion
  it('non-zero exit code never triggers completion (property)', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer().filter((n) => n !== 0),
        (command, exitCode) => {
          const result = detectMergeCompletion({ command, exitCode });
          expect(result.shouldComplete).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Property: commands without "gh pr merge" never trigger completion
  it('commands without gh pr merge never trigger (property)', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/\bgh\s+pr\s+merge\b/.test(s)),
        (command) => {
          const result = detectMergeCompletion({ command, exitCode: 0 });
          expect(result.shouldComplete).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('checkHookEventForCompletion', () => {
  it('returns completion for valid merge event', () => {
    const json = JSON.stringify({
      input: { command: 'gh pr merge 42 --squash' },
      output: { exitCode: 0 },
    });
    const result = checkHookEventForCompletion(json);
    expect(result).toEqual({ shouldComplete: true, reason: 'merged' });
  });

  it('returns no completion for invalid JSON', () => {
    const result = checkHookEventForCompletion('garbage');
    expect(result).toEqual({ shouldComplete: false, reason: 'merged' });
  });

  it('returns no completion for non-merge command', () => {
    const json = JSON.stringify({
      input: { command: 'npm test' },
      output: { exitCode: 0 },
    });
    const result = checkHookEventForCompletion(json);
    expect(result).toEqual({ shouldComplete: false, reason: 'merged' });
  });

  it('returns no completion for failed merge', () => {
    const json = JSON.stringify({
      input: { command: 'gh pr merge 42' },
      output: { exitCode: 1 },
    });
    const result = checkHookEventForCompletion(json);
    expect(result).toEqual({ shouldComplete: false, reason: 'merged' });
  });
});
