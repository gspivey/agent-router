/**
 * Tier 1 tests for the web UI grouped-by-repo frontend (ROADMAP #52, tasks 6/7/8).
 * Verifies that the rendered HTML template contains the correct CSS classes,
 * JS functions, accessibility attributes, and structural elements for the
 * grouped session list view.
 */
import { describe, it, expect } from 'vitest';
import { renderWebUI } from '../../../src/web-ui.js';

const html = renderWebUI({ embedToken: false, token: '' });

describe('Task 6: CSS for grouped layout', () => {
  it('contains .repo-section class with border and border-radius', () => {
    expect(html).toContain('.repo-section{');
    expect(html).toContain('border:1px solid #30363d');
    expect(html).toContain('border-radius:8px');
  });

  it('contains .repo-header class with flex layout and min-height for touch target', () => {
    expect(html).toContain('.repo-header{');
    expect(html).toContain('min-height:44px');
    expect(html).toContain('cursor:pointer');
  });

  it('contains .repo-header h2 styling', () => {
    expect(html).toContain('.repo-header h2{');
  });

  it('contains .repo-header-info for right-aligned info', () => {
    expect(html).toContain('.repo-header-info{');
    expect(html).toContain('font-size:13px');
  });

  it('contains .repo-cron styling', () => {
    expect(html).toContain('.repo-cron{');
    expect(html).toContain('font-size:12px');
  });

  it('contains .repo-body class', () => {
    expect(html).toContain('.repo-body{');
  });

  it('hides .repo-body when section is collapsed', () => {
    expect(html).toContain('.repo-section.collapsed .repo-body{display:none}');
  });

  it('hides .repo-cron when section is collapsed', () => {
    expect(html).toContain('.repo-section.collapsed .repo-cron{display:none}');
  });

  it('contains .streaming-dot with pulse animation', () => {
    expect(html).toContain('.streaming-dot{');
    expect(html).toContain('background:#3fb950');
    expect(html).toContain('animation:pulse 1.5s infinite');
  });

  it('defines @keyframes pulse animation', () => {
    expect(html).toContain('@keyframes pulse{');
    expect(html).toContain('opacity:1');
    expect(html).toContain('opacity:0.4');
  });

  it('contains .show-more-btn with 44px min-height for touch target', () => {
    expect(html).toContain('.show-more-btn{');
    expect(html).toContain('min-height:44px');
  });

  it('contains .collapse-icon with rotation transform', () => {
    expect(html).toContain('.collapse-icon{');
    expect(html).toContain('.repo-section.collapsed .collapse-icon{transform:rotate(-90deg)}');
  });

  it('has responsive overrides for repo-header at 480px', () => {
    expect(html).toContain('.repo-header{gap:4px}');
  });
});

describe('Task 7: List-view JS renders grouped sections', () => {
  it('defines loadGroupedSessions function that calls /repos/sessions', () => {
    expect(html).toContain("resilientFetch('/repos/sessions')");
  });

  it('defines renderGroupedList function', () => {
    expect(html).toContain('function renderGroupedList(repos)');
  });

  it('renders empty state when no repos', () => {
    expect(html).toContain("'<div class=\"empty-state\">No repos configured</div>'");
  });

  it('defines isAutoCollapsed function', () => {
    expect(html).toContain('function isAutoCollapsed(repoGroup)');
  });

  it('checks 24h threshold for auto-collapse', () => {
    expect(html).toContain('24 * 60 * 60 * 1000');
  });

  it('reads collapse state from localStorage', () => {
    expect(html).toContain("localStorage.getItem(key)");
  });

  it('writes collapse state to localStorage', () => {
    expect(html).toContain("localStorage.setItem(key, collapsed ? '1' : '0')");
  });

  it('renders repo-section with data-repo attribute', () => {
    expect(html).toContain('data-repo="');
  });

  it('renders h2 for repo name (semantic heading)', () => {
    expect(html).toContain("'<h2>'");
  });

  it('renders collapse icon', () => {
    expect(html).toContain('<span class="collapse-icon">');
  });

  it('renders streaming-dot for active sessions with accessibility', () => {
    expect(html).toContain('aria-label="Active session streaming"');
    expect(html).toContain('role="img"');
  });

  it('renders aria-expanded attribute on repo-header', () => {
    expect(html).toContain("aria-expanded=");
  });

  it('renders aria-controls attribute linking header to body', () => {
    expect(html).toContain("aria-controls=");
  });

  it('renders repo-body with matching id for aria-controls', () => {
    expect(html).toContain("id=\"' + sectionId + '\"");
  });

  it('uses escapeHtml for repo name rendering', () => {
    expect(html).toContain('escapeHtml(repoGroup.repo)');
  });

  it('renders cron info when present', () => {
    expect(html).toContain('repoGroup.cron');
    expect(html).toContain("'<div class=\"repo-cron\">'");
  });

  it('renders open PR count as link', () => {
    expect(html).toContain("repoGroup.open_pr_count > 0");
    expect(html).toContain("github.com/' + repoGroup.repo + '/pulls");
  });

  it('handles error states for auth and network failures', () => {
    expect(html).toContain("result.outcome === 'auth'");
    expect(html).toContain("Authentication failed");
    expect(html).toContain("Failed to load sessions");
  });

  it('attaches click handlers for collapse/expand', () => {
    expect(html).toContain("header.closest('.repo-section')");
    expect(html).toContain("section.classList.toggle('collapsed')");
  });

  it('defines renderSessionItemWithDot for active sessions', () => {
    expect(html).toContain('function renderSessionItemWithDot(session)');
  });

  it('does not use old currentPage/PAGE_SIZE state', () => {
    expect(html).not.toContain('currentPage');
    expect(html).not.toContain('PAGE_SIZE');
    expect(html).not.toContain('totalSessions');
  });
});

describe('Task 8: "Show more" per-repo pagination', () => {
  it('renders show-more-btn when terminal_total > displayed', () => {
    expect(html).toContain("repoGroup.terminal_total > currentCount");
    expect(html).toContain("class=\"show-more-btn\"");
  });

  it('show-more-btn has data-repo attribute', () => {
    expect(html).toContain("data-repo=\"' + repoGroup.repo + '\"");
  });

  it('show-more-btn has aria-label', () => {
    expect(html).toContain("aria-label=\"Load more sessions for");
  });

  it('defines handleShowMore function', () => {
    expect(html).toContain('async function handleShowMore(btn)');
  });

  it('handleShowMore calls /repos/:repo/sessions with offset and limit', () => {
    expect(html).toContain("'/repos/' + encodeURIComponent(repo) + '/sessions?offset=' + offset + '&limit=5'");
  });

  it('tracks per-repo offsets in repoOffsets map', () => {
    expect(html).toContain('const repoOffsets = new Map()');
    expect(html).toContain('repoOffsets.set(');
    expect(html).toContain('repoOffsets.get(');
  });

  it('removes button when all sessions loaded', () => {
    expect(html).toContain("btn.remove()");
    expect(html).toContain("newOffset >= data.total");
  });

  it('shows remaining count on button', () => {
    expect(html).toContain("remaining)");
  });

  it('handles fetch errors gracefully with retry', () => {
    expect(html).toContain("'Failed to load — click to retry'");
  });

  it('disables button while loading', () => {
    expect(html).toContain("btn.disabled = true");
    expect(html).toContain("btn.textContent = 'Loading...'");
  });

  it('inserts loaded sessions before the button', () => {
    expect(html).toContain("btn.insertAdjacentHTML('beforebegin', html)");
  });
});
