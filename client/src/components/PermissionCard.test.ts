import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import PermissionCard from './PermissionCard.svelte';

/**
 * PermissionCard unit tests (BACKLOG.md § P2.58 / ROADMAP item 142).
 *
 * The PermissionCard is a READ-ONLY component: it shows what the agent is
 * requesting permission for but provides no Accept/Decline controls
 * (per the spec: "Permission responses are out of scope", NFR-2.1).
 *
 * Tests verify:
 *   1. Outer container renders with data-testid="permission-card".
 *   2. The "Permission requested" label appears.
 *   3. The title prop text appears in the card body.
 *   4. No action buttons are present (read-only invariant).
 */

afterEach(() => cleanup());

describe('PermissionCard', () => {
  it('renders with data-testid="permission-card"', () => {
    const { getByTestId } = render(PermissionCard, { title: 'Read file' });
    expect(getByTestId('permission-card')).toBeTruthy();
  });

  it('shows the "Permission requested" label', () => {
    const { getByTestId } = render(PermissionCard, { title: 'Write file' });
    const card = getByTestId('permission-card');
    expect(card.textContent).toContain('Permission requested');
  });

  it('renders the title prop as the card body text', () => {
    const { getByTestId } = render(PermissionCard, { title: 'Execute bash command' });
    const card = getByTestId('permission-card');
    expect(card.textContent).toContain('Execute bash command');
  });

  it('renders a different title prop correctly', () => {
    const { getByTestId } = render(PermissionCard, { title: 'Access GitHub API' });
    const card = getByTestId('permission-card');
    expect(card.textContent).toContain('Access GitHub API');
  });

  it('has no button elements (read-only — no Accept/Decline)', () => {
    const { getByTestId } = render(PermissionCard, { title: 'Something' });
    const card = getByTestId('permission-card');
    expect(card.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders without error for an empty title', () => {
    expect(() => render(PermissionCard, { title: '' })).not.toThrow();
  });
});
