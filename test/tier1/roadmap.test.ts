import { describe, it, expect } from 'vitest';
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
