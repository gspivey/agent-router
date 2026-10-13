import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import StatusBadge from './StatusBadge.svelte';

/**
 * StatusBadge unit tests (spa-polish ROADMAP 87, Req 3).
 *
 * Asserts the badge renders the correct default label and dot token per state,
 * the dot is `aria-hidden`, a text label is always present (no color-only
 * meaning), and a `label` override replaces the default text.
 */
describe('StatusBadge', () => {
  afterEach(cleanup);

  it('renders default label + success dot for active', () => {
    const { getByTestId } = render(StatusBadge, { state: 'active' });
    const badge = getByTestId('status-badge');
    expect(badge.getAttribute('data-state')).toBe('active');
    expect(badge.textContent).toContain('Active');
    const dot = badge.querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute('style')).toContain('var(--success)');
  });

  it('renders Paused + warning dot', () => {
    const { getByTestId } = render(StatusBadge, { state: 'paused' });
    const badge = getByTestId('status-badge');
    expect(badge.textContent).toContain('Paused');
    expect(badge.querySelector('span[aria-hidden="true"]')!.getAttribute('style')).toContain(
      'var(--warning)',
    );
  });

  it('renders Error + error dot', () => {
    const { getByTestId } = render(StatusBadge, { state: 'error' });
    const badge = getByTestId('status-badge');
    expect(badge.textContent).toContain('Error');
    expect(badge.querySelector('span[aria-hidden="true"]')!.getAttribute('style')).toContain(
      'var(--error)',
    );
  });

  it('uses the label override when provided', () => {
    const { getByTestId } = render(StatusBadge, { state: 'active', label: 'Healthy' });
    const badge = getByTestId('status-badge');
    expect(badge.textContent).toContain('Healthy');
    expect(badge.textContent).not.toContain('Active');
  });
});
