export interface RoadmapTask {
  text: string;
  checked: boolean;
  line: number;
}

const UNCHECKED_RE = /^[-*]\s+\[\s\]/;
const CHECKED_RE = /^[-*]\s+\[x\]/i;
const CHECKBOX_MARKER_RE = /^[-*]\s+\[[ xX]\]\s*/;

export function parseRoadmap(content: string): RoadmapTask[] {
  if (content === '') return [];

  const lines = content.split('\n');
  const tasks: RoadmapTask[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (UNCHECKED_RE.test(line)) {
      tasks.push({
        text: line.replace(CHECKBOX_MARKER_RE, '').trim(),
        checked: false,
        line: i,
      });
    } else if (CHECKED_RE.test(line)) {
      tasks.push({
        text: line.replace(CHECKBOX_MARKER_RE, '').trim(),
        checked: true,
        line: i,
      });
    }
  }

  return tasks;
}

export function findNextTask(tasks: RoadmapTask[]): RoadmapTask | null {
  return tasks.find((t) => !t.checked) ?? null;
}

export function markTaskChecked(content: string, taskLine: number): string {
  const lines = content.split('\n');
  const target = lines[taskLine];
  if (target !== undefined) {
    lines[taskLine] = target.replace('[ ]', '[x]');
  }
  return lines.join('\n');
}
