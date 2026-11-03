import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseRoadmap, findNextTask, markTaskChecked } from '../../src/roadmap.js';

describe('parseRoadmap', () => {
  it('parses unchecked tasks with - bullet', () => {
    const content = '- [ ] First task\n- [ ] Second task';
    const tasks = parseRoadmap(content);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual({ text: 'First task', checked: false, line: 0 });
    expect(tasks[1]).toEqual({ text: 'Second task', checked: false, line: 1 });
  });

  it('parses checked tasks with - bullet', () => {
    const content = '- [x] Done task';
    const tasks = parseRoadmap(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({ text: 'Done task', checked: true, line: 0 });
  });

  it('parses case-insensitive [X] as checked', () => {
    const content = '- [X] Upper case checked';
    const tasks = parseRoadmap(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.checked).toBe(true);
    expect(tasks[0]!.text).toBe('Upper case checked');
  });

  it('parses tasks with * bullet marker', () => {
    const content = '* [ ] Star unchecked\n* [x] Star checked';
    const tasks = parseRoadmap(content);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual({ text: 'Star unchecked', checked: false, line: 0 });
    expect(tasks[1]).toEqual({ text: 'Star checked', checked: true, line: 1 });
  });

  it('ignores non-task lines', () => {
    const content = '# Roadmap\n\nSome description\n- [ ] Real task\nAnother line';
    const tasks = parseRoadmap(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({ text: 'Real task', checked: false, line: 3 });
  });

  it('returns empty array for empty content', () => {
    expect(parseRoadmap('')).toEqual([]);
  });

  it('returns empty array for content with no tasks', () => {
    const content = '# Title\n\nJust some text.';
    expect(parseRoadmap(content)).toEqual([]);
  });

  it('handles mixed checked and unchecked tasks', () => {
    const content = '- [x] Done\n- [ ] Todo\n* [X] Also done\n* [ ] Also todo';
    const tasks = parseRoadmap(content);
    expect(tasks).toHaveLength(4);
    expect(tasks[0]!.checked).toBe(true);
    expect(tasks[1]!.checked).toBe(false);
    expect(tasks[2]!.checked).toBe(true);
    expect(tasks[3]!.checked).toBe(false);
  });
});

describe('findNextTask', () => {
  it('returns the first unchecked task', () => {
    const tasks = [
      { text: 'Done', checked: true, line: 0 },
      { text: 'First todo', checked: false, line: 1 },
      { text: 'Second todo', checked: false, line: 2 },
    ];
    const next = findNextTask(tasks);
    expect(next).toEqual({ text: 'First todo', checked: false, line: 1 });
  });

  it('returns null when all tasks are checked', () => {
    const tasks = [
      { text: 'Done 1', checked: true, line: 0 },
      { text: 'Done 2', checked: true, line: 1 },
    ];
    expect(findNextTask(tasks)).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(findNextTask([])).toBeNull();
  });
});

describe('markTaskChecked', () => {
  it('replaces [ ] with [x] on the target line', () => {
    const content = '- [ ] First\n- [ ] Second';
    const result = markTaskChecked(content, 0);
    expect(result).toBe('- [x] First\n- [ ] Second');
  });

  it('preserves all other lines unchanged', () => {
    const content = '# Title\n- [ ] Task\nSome text';
    const result = markTaskChecked(content, 1);
    expect(result).toBe('# Title\n- [x] Task\nSome text');
  });

  it('handles * bullet marker', () => {
    const content = '* [ ] Star task';
    const result = markTaskChecked(content, 0);
    expect(result).toBe('* [x] Star task');
  });

  it('does not modify already checked tasks', () => {
    const content = '- [x] Already done';
    const result = markTaskChecked(content, 0);
    expect(result).toBe('- [x] Already done');
  });

  it('returns content unchanged for out-of-range line', () => {
    const content = '- [ ] Only task';
    const result = markTaskChecked(content, 5);
    expect(result).toBe('- [ ] Only task');
  });
});

// ---------------------------------------------------------------------------
// Property 6.4: Roadmap Task Parsing (spec task 6.4)
// ---------------------------------------------------------------------------

describe('Property 6.4: Roadmap Task Parsing', () => {
  // Arbitrary that generates a single checkbox line text (no newlines in task text)
  const taskText = fc.string({ minLength: 0, maxLength: 80 }).map((s) => s.replace(/\n/g, ' '));

  // Arbitrary that generates a single checkbox line: either unchecked or checked
  const checkboxLine = fc.record({
    text: taskText,
    checked: fc.boolean(),
    bullet: fc.constantFrom('-', '*') as fc.Arbitrary<string>,
  }).map(({ text, checked, bullet }) => {
    const marker = checked ? '[x]' : '[ ]';
    return { line: `${bullet} ${marker} ${text}`.trimEnd(), checked, text: text.trim() };
  });

  // Arbitrary that generates a non-checkbox prose line (doesn't look like a checkbox)
  const proseLine = fc
    .string({ minLength: 0, maxLength: 80 })
    .map((s) => s.replace(/\n/g, ' '))
    .filter((s) => {
      const trimmed = s.trim();
      return (
        !trimmed.startsWith('- [ ]') &&
        !trimmed.startsWith('- [x]') &&
        !trimmed.startsWith('- [X]') &&
        !trimmed.startsWith('* [ ]') &&
        !trimmed.startsWith('* [x]') &&
        !trimmed.startsWith('* [X]')
      );
    });

  it('Property 6.4.1: N checkbox lines produce exactly N tasks', () => {
    fc.assert(
      fc.property(
        fc.array(checkboxLine, { minLength: 0, maxLength: 20 }),
        (items) => {
          const content = items.map((item) => item.line).join('\n');
          const tasks = parseRoadmap(content);
          return tasks.length === items.length;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 6.4.2: checked field matches source line marker', () => {
    fc.assert(
      fc.property(
        fc.array(checkboxLine, { minLength: 1, maxLength: 20 }),
        (items) => {
          const content = items.map((item) => item.line).join('\n');
          const tasks = parseRoadmap(content);
          return tasks.every((task, i) => {
            const expected = items[i];
            return expected !== undefined && task.checked === expected.checked;
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 6.4.3: line index matches 0-based position in content', () => {
    fc.assert(
      fc.property(
        fc.array(checkboxLine, { minLength: 1, maxLength: 15 }),
        (items) => {
          const content = items.map((item) => item.line).join('\n');
          const tasks = parseRoadmap(content);
          // Each task's line field must be the exact line index in the split content
          return tasks.every((task, i) => task.line === i);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 6.4.4: surrounding prose lines are not included in results', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(
          checkboxLine.map((c) => ({ kind: 'task' as const, data: c })),
          proseLine.map((p) => ({ kind: 'prose' as const, data: p })),
        ), { minLength: 1, maxLength: 20 }),
        (mixed) => {
          const lines = mixed.map((item) =>
            item.kind === 'task' ? item.data.line : item.data,
          );
          const content = lines.join('\n');
          const tasks = parseRoadmap(content);
          const taskCount = mixed.filter((item) => item.kind === 'task').length;
          return tasks.length === taskCount;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6.5: Parse/Reconstruct Round-Trip (spec task 6.5)
// ---------------------------------------------------------------------------

describe('Property 6.5: Parse/Reconstruct Round-Trip', () => {
  const checkboxLine = fc.record({
    text: fc.string({ minLength: 0, maxLength: 60 }).map((s) => s.replace(/\n/g, ' ')),
    checked: fc.boolean(),
    bullet: fc.constantFrom('-', '*') as fc.Arbitrary<string>,
  }).map(({ text, checked, bullet }) => {
    const marker = checked ? '[x]' : '[ ]';
    return `${bullet} ${marker} ${text}`.trimEnd();
  });

  it('Property 6.5.1: markTaskChecked changes exactly the target line from [ ] to [x]', () => {
    // Generate content with at least one unchecked task
    fc.assert(
      fc.property(
        fc.array(checkboxLine, { minLength: 1, maxLength: 10 }),
        (lines) => {
          const content = lines.join('\n');
          const tasks = parseRoadmap(content);
          const unchecked = tasks.find((t) => !t.checked);
          if (!unchecked) return true; // skip if all already checked

          const result = markTaskChecked(content, unchecked.line);
          const resultLines = result.split('\n');
          const originalLines = content.split('\n');

          // The target line changed from [ ] to [x]
          const targetOriginal = originalLines[unchecked.line] ?? '';
          const targetResult = resultLines[unchecked.line] ?? '';
          if (!targetOriginal.includes('[ ]')) return false;
          if (!targetResult.includes('[x]')) return false;
          if (targetResult !== targetOriginal.replace('[ ]', '[x]')) return false;

          // All other lines are unchanged
          for (let i = 0; i < Math.max(originalLines.length, resultLines.length); i++) {
            if (i !== unchecked.line && originalLines[i] !== resultLines[i]) return false;
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 6.5.2: after markTaskChecked, parseRoadmap sees the task as checked', () => {
    fc.assert(
      fc.property(
        fc.array(checkboxLine, { minLength: 1, maxLength: 10 }),
        (lines) => {
          const content = lines.join('\n');
          const tasks = parseRoadmap(content);
          const unchecked = tasks.find((t) => !t.checked);
          if (!unchecked) return true; // skip if all already checked

          const result = markTaskChecked(content, unchecked.line);
          const updatedTasks = parseRoadmap(result);
          const updatedTask = updatedTasks.find((t) => t.line === unchecked.line);
          return updatedTask !== undefined && updatedTask.checked === true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
