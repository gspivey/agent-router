import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import ToolCallCard from './ToolCallCard.svelte';

/**
 * ToolCallCard output-truncation tests (spa-operator-restoration Task B-8 /
 * ROADMAP 81).
 *
 * Covers FR-5.1 (truncate at >20 lines + "Show N more lines" button, expand-only)
 * and FR-5.2 (header always visible; spinner interaction).
 */

function makeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

describe('ToolCallCard — output truncation (FR-5)', () => {
  afterEach(cleanup);

  it('renders only 20 lines + a "Show 5 more lines" button for 25 lines', () => {
    const { getByTestId } = render(ToolCallCard, {
      title: 't',
      updates: makeLines(25),
      collapsed: false,
    });
    const body = getByTestId('tool-call-body');
    expect(body.textContent).toContain('line 20');
    expect(body.textContent).not.toContain('line 21');
    expect(getByTestId('tool-call-show-more').textContent).toContain('Show 5 more lines');
  });

  it('renders no show-more button for exactly 20 lines', () => {
    const { getByTestId, queryByTestId } = render(ToolCallCard, {
      title: 't',
      updates: makeLines(20),
      collapsed: false,
    });
    expect(getByTestId('tool-call-body').textContent).toContain('line 20');
    expect(queryByTestId('tool-call-show-more')).toBeNull();
  });

  it('renders no show-more button for a short output', () => {
    const { queryByTestId } = render(ToolCallCard, {
      title: 't',
      updates: 'single line',
      collapsed: false,
    });
    expect(queryByTestId('tool-call-show-more')).toBeNull();
  });

  it('expands to all lines on click and removes the button (expand-only)', async () => {
    const { getByTestId, queryByTestId } = render(ToolCallCard, {
      title: 't',
      updates: makeLines(25),
      collapsed: false,
    });
    await fireEvent.click(getByTestId('tool-call-show-more'));
    expect(getByTestId('tool-call-body').textContent).toContain('line 25');
    // Expand-only: no button remains afterward (AC-5.1c, AC-5.1d).
    expect(queryByTestId('tool-call-show-more')).toBeNull();
  });

  it('hides the body (and show-more) entirely while spinning (FR-5.2b)', () => {
    const { queryByTestId } = render(ToolCallCard, {
      title: 't',
      updates: makeLines(25),
      collapsed: false,
      spinner: true,
    });
    expect(queryByTestId('tool-call-body')).toBeNull();
    expect(queryByTestId('tool-call-show-more')).toBeNull();
  });

  it('keeps the header visible regardless of truncation (FR-5.2a)', () => {
    const { getByTestId } = render(ToolCallCard, {
      title: 'my-tool',
      updates: makeLines(25),
      collapsed: true,
    });
    expect(getByTestId('tool-call-header').textContent).toContain('my-tool');
  });

  it('applies truncation once the spinner clears', () => {
    // spinner false (default) + 25 lines → truncation applies.
    const { getByTestId } = render(ToolCallCard, {
      title: 't',
      updates: makeLines(25),
      collapsed: false,
      spinner: false,
    });
    expect(getByTestId('tool-call-show-more').textContent).toContain('Show 5 more lines');
  });
});
