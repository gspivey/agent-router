import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import MessageBubble from './MessageBubble.svelte';
import SystemPill from './SystemPill.svelte';
import ToolCallCard from './ToolCallCard.svelte';
import PermissionCard from './PermissionCard.svelte';
import InternalPill from './InternalPill.svelte';
import UnknownPill from './UnknownPill.svelte';

/**
 * Entry-kind component unit tests (spa-overhaul Task 5 / ROADMAP 75).
 *
 * Each `ParsedEntry` kind renders its dedicated component (Req 6.2–6.7). The
 * permission card renders NO action buttons (Req 6.5). Agent content is rendered
 * as PLAIN TEXT — the v1 XSS boundary (NFR-6.3): a hostile `<img onerror>` string
 * produces no `<img>` element and does not execute.
 */

afterEach(cleanup);

describe('MessageBubble (Req 6.2)', () => {
  it('renders the agent text right-aligned', () => {
    const { getByTestId } = render(MessageBubble, { text: 'hello world' });
    const bubble = getByTestId('message-bubble');
    expect(bubble.textContent).toContain('hello world');
    // Right-aligned: the flex container justifies to the end.
    expect(bubble.className).toContain('justify-end');
  });

  it('renders content as PLAIN TEXT — no HTML injection (NFR-6.3)', () => {
    const hostile = '<img src="x" onerror="window.xss=1">';
    const { getByTestId } = render(MessageBubble, { text: hostile });
    const bubble = getByTestId('message-bubble');
    // No <img> element is created — Svelte text interpolation escapes it.
    expect(bubble.querySelector('img')).toBeNull();
    // The raw markup is visible verbatim as text.
    expect(bubble.textContent).toContain(hostile);
    // And the onerror never ran.
    expect((window as unknown as { xss?: unknown }).xss).toBeUndefined();
  });
});

describe('SystemPill (Req 6.3)', () => {
  it('renders centered pill text', () => {
    const { getByTestId } = render(SystemPill, { text: 'Session started' });
    const pill = getByTestId('system-pill');
    expect(pill.textContent).toContain('Session started');
    expect(pill.className).toContain('justify-center');
  });

  it('applies the success color for a green badge', () => {
    const { getByTestId } = render(SystemPill, { text: 'Verified', badge: 'green' });
    const pill = getByTestId('system-pill');
    expect(pill.getAttribute('data-badge')).toBe('green');
    expect(pill.innerHTML).toContain('var(--success)');
  });

  it('applies the warning color for a yellow badge and error for red', () => {
    const { getByTestId: g1 } = render(SystemPill, { text: 'warn', badge: 'yellow' });
    expect(g1('system-pill').innerHTML).toContain('var(--warning)');
    cleanup();
    const { getByTestId: g2 } = render(SystemPill, { text: 'err', badge: 'red' });
    expect(g2('system-pill').innerHTML).toContain('var(--error)');
  });
});

describe('ToolCallCard (Req 6.4, 6.8)', () => {
  it('renders the title and the folded update body when expanded', () => {
    const { getByTestId } = render(ToolCallCard, {
      title: 'read_file',
      updates: 'file contents',
      collapsed: false,
    });
    expect(getByTestId('tool-call-header').textContent).toContain('read_file');
    expect(getByTestId('tool-call-body').textContent).toContain('file contents');
  });

  it('starts collapsed when collapsed=true and expands on header activation (Req 6.8)', async () => {
    const { getByTestId, queryByTestId } = render(ToolCallCard, {
      title: 'run',
      updates: 'output',
      collapsed: true,
    });
    // Collapsed: the body is not rendered.
    expect(queryByTestId('tool-call-body')).toBeNull();
    expect(getByTestId('tool-call-header').getAttribute('aria-expanded')).toBe('false');
    // Activating the header expands it.
    await fireEvent.click(getByTestId('tool-call-header'));
    expect(getByTestId('tool-call-body').textContent).toContain('output');
    expect(getByTestId('tool-call-header').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('PermissionCard (Req 6.5)', () => {
  it('renders the request title and NO action buttons', () => {
    const { getByTestId } = render(PermissionCard, { title: 'approve shell command' });
    const card = getByTestId('permission-card');
    expect(card.textContent).toContain('approve shell command');
    // READ-ONLY: no Accept/Decline or any <button> control.
    expect(card.querySelectorAll('button').length).toBe(0);
  });
});

describe('InternalPill (Req 6.6)', () => {
  it('renders the precomputed metadata text and expands on activation', async () => {
    const { getByTestId } = render(InternalPill, { text: 'Context 42% · 1.3s' });
    const toggle = getByTestId('internal-pill-toggle');
    expect(toggle.textContent).toContain('Context 42%');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('UnknownPill (Req 6.7)', () => {
  it('renders only the type label, never a raw payload', () => {
    const { getByTestId } = render(UnknownPill, { typeLabel: 'mystery_type' });
    const pill = getByTestId('unknown-pill');
    expect(pill.textContent?.trim()).toBe('mystery_type');
  });
});
