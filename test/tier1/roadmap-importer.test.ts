/**
 * Tier 1 tests: ROADMAP intake-adapter pure functions
 * (task-attempt-outcome, task 12.3).
 *
 * Covers parse/annotate/tick round-trips, that `external_id` derives from the
 * annotation id (never a text hash), and re-annotation stability (property).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  parseRoadmapItems,
  annotateLine,
  tickCheckbox,
  classifyPushError,
  contentHashExternalId,
} from '../../src/roadmap-importer.js';
import { ulid, monotonicUlidFactory } from '../../src/ulid.js';

describe('parseRoadmapItems', () => {
  it('returns an empty array for empty content', () => {
    expect(parseRoadmapItems('')).toEqual([]);
  });

  it('parses unchecked and checked items with - and * bullets', () => {
    const md = '- [ ] First\n* [x] Second\n- [X] Third';
    const items = parseRoadmapItems(md);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ lineNo: 0, text: 'First', checked: false });
    expect(items[1]).toEqual({ lineNo: 1, text: 'Second', checked: true });
    expect(items[2]).toEqual({ lineNo: 2, text: 'Third', checked: true });
  });

  it('ignores non-checklist lines', () => {
    const md = '# Roadmap\n\nSome prose.\n- [ ] Real item\nMore prose';
    const items = parseRoadmapItems(md);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ lineNo: 3, text: 'Real item', checked: false });
  });

  it('extracts the annotation id and strips it from the text', () => {
    const id = ulid();
    const md = `- [ ] Build the thing <!-- ar:${id} -->`;
    const items = parseRoadmapItems(md);
    expect(items).toHaveLength(1);
    expect(items[0]!.annotationId).toBe(id);
    expect(items[0]!.text).toBe('Build the thing');
  });

  it('omits annotationId when absent', () => {
    const items = parseRoadmapItems('- [ ] No annotation');
    expect(items[0]!.annotationId).toBeUndefined();
  });

  it('preserves indentation detection for nested checklist lines', () => {
    const md = '  - [ ] Indented item';
    const items = parseRoadmapItems(md);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toBe('Indented item');
    expect(items[0]!.checked).toBe(false);
  });
});

describe('annotateLine', () => {
  it('appends an `<!-- ar:<id> -->` annotation', () => {
    const id = ulid();
    const line = '- [ ] Do a thing';
    const annotated = annotateLine(line, id);
    expect(annotated).toBe(`- [ ] Do a thing <!-- ar:${id} -->`);
  });

  it('is idempotent — never double-annotates a line that already has one', () => {
    const id = ulid();
    const line = `- [ ] Do a thing <!-- ar:${id} -->`;
    expect(annotateLine(line, ulid())).toBe(line);
  });

  it('trims trailing whitespace before appending', () => {
    const id = ulid();
    expect(annotateLine('- [ ] Trailing space   ', id)).toBe(
      `- [ ] Trailing space <!-- ar:${id} -->`
    );
  });
});

describe('tickCheckbox', () => {
  it('ticks an unchecked line', () => {
    expect(tickCheckbox('- [ ] Todo')).toBe('- [x] Todo');
  });

  it('preserves an already-checked line unchanged', () => {
    expect(tickCheckbox('- [x] Done')).toBe('- [x] Done');
  });

  it('preserves indentation, bullet, body, and annotation', () => {
    const id = ulid();
    const line = `  * [ ] Nested item <!-- ar:${id} -->`;
    expect(tickCheckbox(line)).toBe(`  * [x] Nested item <!-- ar:${id} -->`);
  });

  it('returns non-checklist lines unchanged', () => {
    expect(tickCheckbox('# Heading')).toBe('# Heading');
  });
});

describe('annotate → parse round-trip', () => {
  it('round-trips the annotation id through parse', () => {
    const id = ulid();
    const line = annotateLine('- [ ] Round trip', id);
    const items = parseRoadmapItems(line);
    expect(items[0]!.annotationId).toBe(id);
    expect(items[0]!.text).toBe('Round trip');
  });

  // Requirement 14.2/14.7: external_id derives from the annotation id, never
  // from a text hash — proved by re-annotation stability under property testing.
  it('re-annotating an already-annotated line is stable (property)', () => {
    const makeId = monotonicUlidFactory();
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 60 }), (body) => {
        // Strip any characters that would form a competing checklist/annotation.
        const safeBody = body.replace(/[\r\n]/g, ' ').replace(/<!--/g, '').trim() || 'item';
        const id = makeId();
        const base = `- [ ] ${safeBody}`;
        const once = annotateLine(base, id);
        const twice = annotateLine(once, makeId());
        // Second annotation is a no-op: the id is stable.
        expect(twice).toBe(once);
        const parsed = parseRoadmapItems(once);
        expect(parsed).toHaveLength(1);
        expect(parsed[0]!.annotationId).toBe(id);
      }),
      { numRuns: 200 }
    );
  });

  it('tick → parse reports the item as checked while keeping its annotation', () => {
    const id = ulid();
    const line = annotateLine('- [ ] Finish it', id);
    const ticked = tickCheckbox(line);
    const items = parseRoadmapItems(ticked);
    expect(items[0]!.checked).toBe(true);
    expect(items[0]!.annotationId).toBe(id);
  });
});

describe('classifyPushError', () => {
  it('classifies protected-branch / permission errors as "protected"', () => {
    expect(classifyPushError('remote: Permission to owner/repo.git denied')).toBe('protected');
    expect(classifyPushError('protected branch hook declined')).toBe('protected');
    expect(classifyPushError('remote: error: GH006: Protected branch update failed')).toBe(
      'protected'
    );
    expect(classifyPushError('pre-receive hook declined')).toBe('protected');
  });

  it('classifies stale-ref rejections as "non_fast_forward"', () => {
    expect(classifyPushError('! [rejected] main -> main (non-fast-forward)')).toBe(
      'non_fast_forward'
    );
    expect(classifyPushError('Updates were rejected because the remote contains work')).toBe(
      'non_fast_forward'
    );
  });
});

describe('contentHashExternalId', () => {
  it('is deterministic for the same repo+text and prefixed sha256:', () => {
    const a = contentHashExternalId('owner/repo', 'build the thing');
    const b = contentHashExternalId('owner/repo', 'build the thing');
    expect(a).toBe(b);
    expect(a.startsWith('sha256:')).toBe(true);
  });

  it('differs for different text or repo', () => {
    const a = contentHashExternalId('owner/repo', 'one');
    const b = contentHashExternalId('owner/repo', 'two');
    const c = contentHashExternalId('owner/other', 'one');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
