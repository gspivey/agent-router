/**
 * Tier 1 tests: agent prompt preamble (task-attempt-outcome, task 5.2a).
 */
import { describe, it, expect } from 'vitest';
import { buildPromptPreamble } from '../../src/attempt-runner.js';
import type { TaskRecord } from '../../src/task-types.js';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    externalId: null,
    repo: 'owner/repo',
    source: 'api',
    sourceRef: null,
    title: 'Do the thing',
    spec: 'Implement feature X and open a PR.',
    baseRef: null,
    agent: 'kiro',
    budget: null,
    metadata: null,
    state: 'running',
    resumeSessionId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('buildPromptPreamble', () => {
  it('names all three agent-declarable outcomes', () => {
    const p = buildPromptPreamble(makeTask(), 'attempt-1', 'agent/attempt-1');
    expect(p).toContain('succeeded');
    expect(p).toContain('failed');
    expect(p).toContain('blocked');
  });

  it('mentions both reporting channels', () => {
    const p = buildPromptPreamble(makeTask(), 'attempt-1', 'agent/attempt-1');
    expect(p).toContain('report_outcome');
    expect(p).toContain('.agent-router/outcome.json');
  });

  it('mentions pr_url', () => {
    const p = buildPromptPreamble(makeTask(), 'attempt-1', 'agent/attempt-1');
    expect(p).toContain('pr_url');
  });

  it('embeds the exact git push command for a fresh attempt', () => {
    const p = buildPromptPreamble(makeTask(), 'attempt-xyz', 'agent/attempt-xyz');
    expect(p).toContain('git push origin agent/attempt-xyz');
  });

  it('embeds the ORIGINAL branch for a resume attempt (HIGH-4)', () => {
    // A resume attempt has a new attempt id but pushes to the original branch.
    const p = buildPromptPreamble(makeTask(), 'attempt-new', 'agent/attempt-original');
    expect(p).toContain('git push origin agent/attempt-original');
    expect(p).not.toContain('git push origin agent/attempt-new');
  });

  it('leaves the spec verbatim (does not mutate task.spec)', () => {
    const task = makeTask({ spec: 'VERBATIM SPEC BODY' });
    const p = buildPromptPreamble(task, 'attempt-1', 'agent/attempt-1');
    // The preamble is framing only; it does not include or alter the spec text.
    expect(p).not.toContain('VERBATIM SPEC BODY');
    expect(task.spec).toBe('VERBATIM SPEC BODY');
  });
});
