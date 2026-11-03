import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import PageLayout from './PageLayout.svelte';

/**
 * PageLayout unit tests (spa-polish ROADMAP 87, Req 5.3 / BACKLOG.md § P2.59).
 *
 * PageLayout is a centered max-width + gutter layout wrapper with two modes:
 *  - `wide` (default) — max-w-6xl with py-6 vertical padding; used by list,
 *    config, and overview views.
 *  - `narrow` — max-w-4xl with NO py-6; used by the chat (detail) view because
 *    py-6 would push the composer below the fold (Req 5.2).
 *
 * Both modes render slot children and expose `data-testid` / `data-width`
 * attributes for querying.
 */

const childSnippet = createRawSnippet(() => ({
  render: () => `<div data-testid="layout-child">content</div>`,
}));

describe('PageLayout', () => {
  afterEach(cleanup);

  // ---- data-testid and data-width ----

  it('renders data-testid="page-layout" in wide mode', () => {
    const { getByTestId } = render(PageLayout, { children: childSnippet });
    expect(getByTestId('page-layout')).toBeTruthy();
  });

  it('renders data-testid="page-layout" in narrow mode', () => {
    const { getByTestId } = render(PageLayout, { width: 'narrow', children: childSnippet });
    expect(getByTestId('page-layout')).toBeTruthy();
  });

  it('sets data-width="wide" when no width prop is supplied (default)', () => {
    const { getByTestId } = render(PageLayout, { children: childSnippet });
    expect(getByTestId('page-layout').getAttribute('data-width')).toBe('wide');
  });

  it('sets data-width="wide" when width="wide" is explicit', () => {
    const { getByTestId } = render(PageLayout, { width: 'wide', children: childSnippet });
    expect(getByTestId('page-layout').getAttribute('data-width')).toBe('wide');
  });

  it('sets data-width="narrow" when width="narrow"', () => {
    const { getByTestId } = render(PageLayout, { width: 'narrow', children: childSnippet });
    expect(getByTestId('page-layout').getAttribute('data-width')).toBe('narrow');
  });

  // ---- CSS class contracts ----

  it('wide mode: applies max-w-6xl', () => {
    const { getByTestId } = render(PageLayout, { children: childSnippet });
    expect(getByTestId('page-layout').className).toContain('max-w-6xl');
  });

  it('wide mode: applies py-6 vertical padding', () => {
    const { getByTestId } = render(PageLayout, { children: childSnippet });
    expect(getByTestId('page-layout').className).toContain('py-6');
  });

  it('wide mode: does NOT apply max-w-4xl', () => {
    const { getByTestId } = render(PageLayout, { children: childSnippet });
    expect(getByTestId('page-layout').className).not.toContain('max-w-4xl');
  });

  it('narrow mode: applies max-w-4xl', () => {
    const { getByTestId } = render(PageLayout, { width: 'narrow', children: childSnippet });
    expect(getByTestId('page-layout').className).toContain('max-w-4xl');
  });

  it('narrow mode: does NOT apply py-6 (critical — keeps the chat composer in view)', () => {
    const { getByTestId } = render(PageLayout, { width: 'narrow', children: childSnippet });
    // py-6 must be absent so the chat composer is not pushed below the fold (Req 5.2).
    expect(getByTestId('page-layout').className).not.toContain('py-6');
  });

  it('narrow mode: does NOT apply max-w-6xl', () => {
    const { getByTestId } = render(PageLayout, { width: 'narrow', children: childSnippet });
    expect(getByTestId('page-layout').className).not.toContain('max-w-6xl');
  });

  // ---- slot children ----

  it('renders slot children in wide mode', () => {
    const { getByTestId } = render(PageLayout, { children: childSnippet });
    expect(getByTestId('layout-child').textContent).toBe('content');
  });

  it('renders slot children in narrow mode', () => {
    const { getByTestId } = render(PageLayout, { width: 'narrow', children: childSnippet });
    expect(getByTestId('layout-child').textContent).toBe('content');
  });
});
