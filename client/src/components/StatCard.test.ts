import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import StatCard from './StatCard.svelte';

/**
 * StatCard unit tests (spa-polish ROADMAP 89, Req 12.3).
 *
 * The card renders a label + value, and renders a `StatusBadge` below the value
 * ONLY when the optional `badge` prop is supplied (the Health card uses
 * `value="System"` + a badge derived from `health`).
 */

describe('StatCard', () => {
  afterEach(cleanup);

  it('renders the label and value', () => {
    const { getByTestId } = render(StatCard, { label: 'Active Sessions', value: 3 });
    const card = getByTestId('stat-card');
    expect(card.getAttribute('data-label')).toBe('Active Sessions');
    expect(getByTestId('stat-card-value').textContent?.trim()).toBe('3');
  });

  it('renders a string value', () => {
    const { getByTestId } = render(StatCard, { label: 'Health', value: 'System' });
    expect(getByTestId('stat-card-value').textContent?.trim()).toBe('System');
  });

  it('does NOT render a StatusBadge when no badge prop is supplied', () => {
    const { queryByTestId } = render(StatCard, { label: 'Queued Work', value: 0 });
    expect(queryByTestId('status-badge')).toBeNull();
  });

  it('renders a StatusBadge with the Healthy label when badge is active', () => {
    const { getByTestId } = render(StatCard, {
      label: 'Health',
      value: 'System',
      badge: { state: 'active', label: 'Healthy' },
    });
    const badge = getByTestId('status-badge');
    expect(badge.getAttribute('data-state')).toBe('active');
    expect(badge.textContent).toContain('Healthy');
  });

  it('renders a StatusBadge with the Degraded label when badge is paused', () => {
    const { getByTestId } = render(StatCard, {
      label: 'Health',
      value: 'System',
      badge: { state: 'paused', label: 'Degraded' },
    });
    const badge = getByTestId('status-badge');
    expect(badge.getAttribute('data-state')).toBe('paused');
    expect(badge.textContent).toContain('Degraded');
  });

  it('renders a StatusBadge with the default label when badge has no label override', () => {
    const { getByTestId } = render(StatCard, {
      label: 'Health',
      value: 'System',
      badge: { state: 'error' },
    });
    const badge = getByTestId('status-badge');
    expect(badge.getAttribute('data-state')).toBe('error');
    expect(badge.textContent).toContain('Error');
  });
});
