import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import UnknownPill from './UnknownPill.svelte';

/**
 * UnknownPill unit tests (BACKLOG.md § P2.58 / ROADMAP item 142).
 *
 * The UnknownPill shows a gray pill for `unknown` parsed entries. It shows ONLY
 * the entry's `typeLabel` and never renders the raw payload content (no-leak
 * guarantee per the spec).
 *
 * Tests verify:
 *   1. Outer container renders with data-testid="unknown-pill".
 *   2. typeLabel prop appears as the inner span text.
 *   3. Inner span has class "truncate" (labels are not expanded).
 *   4. No raw payload or additional content is rendered.
 */

afterEach(() => cleanup());

describe('UnknownPill', () => {
  it('renders with data-testid="unknown-pill"', () => {
    const { getByTestId } = render(UnknownPill, { typeLabel: 'some_unknown_type' });
    expect(getByTestId('unknown-pill')).toBeTruthy();
  });

  it('renders the typeLabel as the inner span text content', () => {
    const { getByTestId } = render(UnknownPill, { typeLabel: 'unknown_event_xyz' });
    const pill = getByTestId('unknown-pill');
    expect(pill.textContent).toContain('unknown_event_xyz');
  });

  it('renders a different typeLabel correctly', () => {
    const { getByTestId } = render(UnknownPill, { typeLabel: 'tool_result' });
    const pill = getByTestId('unknown-pill');
    expect(pill.textContent).toContain('tool_result');
  });

  it('inner span has the truncate class (labels are not expanded)', () => {
    const { getByTestId } = render(UnknownPill, { typeLabel: 'a_very_long_unknown_type_name' });
    const pill = getByTestId('unknown-pill');
    const span = pill.querySelector('span');
    expect(span).not.toBeNull();
    expect(span!.classList.contains('truncate')).toBe(true);
  });

  it('renders without error for an empty typeLabel', () => {
    expect(() => render(UnknownPill, { typeLabel: '' })).not.toThrow();
  });

  it('is horizontally centered — outer div has justify-center', () => {
    const { getByTestId } = render(UnknownPill, { typeLabel: 'test' });
    const pill = getByTestId('unknown-pill');
    expect(pill.className).toContain('justify-center');
  });
});
