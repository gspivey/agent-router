import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import Card from './Card.svelte';
import PageHeader from './PageHeader.svelte';

/**
 * Card + PageHeader unit tests (spa-polish ROADMAP 87, Req 4).
 *
 * Card renders its default slot inside a tokenized surface; PageHeader renders
 * the title `<h1>` and an optional subtitle.
 */

const childSnippet = createRawSnippet(() => ({
  render: () => `<div data-testid="card-child">inside</div>`,
}));

describe('Card', () => {
  afterEach(cleanup);

  it('renders the surface wrapper with its slotted children', () => {
    const { getByTestId } = render(Card, { children: childSnippet });
    const card = getByTestId('card');
    expect(card.className).toContain('rounded-lg');
    expect(card.className).toContain('bg-[var(--surface)]');
    expect(card.className).toContain('border-[var(--border)]');
    expect(getByTestId('card-child').textContent).toBe('inside');
  });
});

describe('PageHeader', () => {
  afterEach(cleanup);

  it('renders the title as an h1', () => {
    const { getByTestId } = render(PageHeader, { title: 'Overview' });
    const header = getByTestId('page-header');
    const h1 = header.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1!.textContent).toBe('Overview');
  });

  it('omits the subtitle when not provided', () => {
    const { queryByTestId } = render(PageHeader, { title: 'Overview' });
    expect(queryByTestId('page-header-subtitle')).toBeNull();
  });

  it('renders the subtitle when provided', () => {
    const { getByTestId } = render(PageHeader, { title: 'Overview', subtitle: 'Daemon status' });
    expect(getByTestId('page-header-subtitle').textContent).toContain('Daemon status');
  });
});
