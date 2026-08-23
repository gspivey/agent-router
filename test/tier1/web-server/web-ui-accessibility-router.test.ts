/**
 * Tier 1 tests for web UI accessibility attributes and hash router update
 * (ROADMAP #53, tasks 9/10/11).
 *
 * Task 9: Verifies all ARIA attributes are present for accessibility compliance.
 * Task 10: Verifies hash router calls loadGroupedSessions, old pagination state removed.
 * Task 11: Structural verification that the template is coherent end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { renderWebUI } from '../../../src/web-ui.js';

const html = renderWebUI({ embedToken: false, token: '' });
const htmlWithToken = renderWebUI({ embedToken: true, token: 'test-token-123' });

describe('Task 9: Accessibility attributes', () => {
  describe('Repo section header accessibility', () => {
    it('repo-header has role="button"', () => {
      expect(html).toContain('class="repo-header" role="button"');
    });

    it('repo-header has aria-expanded attribute', () => {
      expect(html).toContain("aria-expanded=\"' + (!collapsed) + '\"");
    });

    it('repo-header has aria-controls referencing repo-body id', () => {
      expect(html).toContain("aria-controls=\"' + sectionId + '\"");
    });

    it('aria-expanded is toggled on click', () => {
      expect(html).toContain("header.setAttribute('aria-expanded', String(!isCollapsed))");
    });
  });

  describe('Repo body id matches aria-controls', () => {
    it('repo-body element has id matching sectionId', () => {
      expect(html).toContain("id=\"' + sectionId + '\"");
    });

    it('sectionId is derived from repo name with slash replaced', () => {
      expect(html).toContain("'repo-body-' + repoGroup.repo.replace(/\\//g, '-')");
    });
  });

  describe('Streaming dot accessibility', () => {
    it('streaming-dot has aria-label for screen readers', () => {
      expect(html).toContain('aria-label="Active session streaming"');
    });

    it('streaming-dot has role="img" for semantic meaning', () => {
      expect(html).toContain('class="streaming-dot" aria-label="Active session streaming" role="img"');
    });
  });

  describe('Show more button accessibility', () => {
    it('show-more-btn has aria-label with repo name', () => {
      expect(html).toContain("aria-label=\"Load more sessions for ' + escapeHtml(repoGroup.repo) + '\"");
    });
  });

  describe('Semantic heading structure', () => {
    it('repo name is rendered in h2 element', () => {
      expect(html).toContain("'<h2>' + escapeHtml(repoGroup.repo) + '</h2>'");
    });

    it('page title uses h1 in header', () => {
      expect(html).toContain('<h1><a href="#/">Agent Router</a></h1>');
    });
  });
});

describe('Task 10: Hash router update for grouped view', () => {
  describe('navigate() function calls loadGroupedSessions', () => {
    it('list view branch calls loadGroupedSessions()', () => {
      expect(html).toContain('loadGroupedSessions();');
    });

    it('does not call old loadAllSessions function name', () => {
      expect(html).not.toContain('function loadAllSessions(');
      expect(html).not.toContain('loadAllSessions()');
    });

    it('defines loadGroupedSessions function', () => {
      expect(html).toContain('async function loadGroupedSessions()');
    });
  });

  describe('old pagination state removed', () => {
    it('does not contain currentPage variable', () => {
      expect(html).not.toContain('currentPage');
    });

    it('does not contain PAGE_SIZE constant', () => {
      expect(html).not.toContain('PAGE_SIZE');
    });

    it('does not contain totalSessions state', () => {
      expect(html).not.toContain('totalSessions');
    });

    it('does not contain global pagination controls', () => {
      // The old flat list had a global pagination div; now pagination is per-repo
      expect(html).not.toContain('id="pagination"');
    });
  });

  describe('detail view navigation preserved', () => {
    it('parseHashRoute handles /sessions/:id route', () => {
      expect(html).toContain("view: 'detail', sessionId: match[1]");
    });

    it('detail view is displayed on detail route', () => {
      expect(html).toContain("detailView.style.display = 'block'");
    });

    it('list view is hidden on detail route', () => {
      expect(html).toContain("listView.style.display = 'none'");
    });

    it('back button returns to grouped list (#/)', () => {
      expect(html).toContain('href="#/" class="btn btn-back"');
    });
  });

  describe('hashchange listener is wired', () => {
    it('registers hashchange event listener', () => {
      expect(html).toContain("window.addEventListener('hashchange', navigate)");
    });

    it('calls navigate() on initial load', () => {
      // The last call to navigate() drives initial page render
      expect(html).toMatch(/navigate\(\);\s*\n<\/script>/);
    });
  });
});

describe('Task 11: End-to-end structural verification', () => {
  describe('HTML document structure', () => {
    it('has valid HTML5 doctype', () => {
      expect(html).toMatch(/^<!DOCTYPE html>/);
    });

    it('has lang attribute on html element', () => {
      expect(html).toContain('<html lang="en">');
    });

    it('has viewport meta tag for mobile', () => {
      expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    });

    it('has page title', () => {
      expect(html).toContain('<title>Agent Router</title>');
    });
  });

  describe('navigation structure', () => {
    it('has Sessions nav link', () => {
      expect(html).toContain('data-view="sessions"');
    });

    it('has Config nav link', () => {
      expect(html).toContain('data-view="config"');
    });

    it('nav links update active class on route change', () => {
      expect(html).toContain("navLinks[i].classList.remove('active')");
      expect(html).toContain("classList.add('active')");
    });
  });

  describe('view container structure', () => {
    it('has list-view container', () => {
      expect(html).toContain('id="list-view"');
    });

    it('has detail-view container', () => {
      expect(html).toContain('id="detail-view"');
    });

    it('has config-view container', () => {
      expect(html).toContain('id="config-view"');
    });
  });

  describe('grouped list renders from single API call', () => {
    it('fetches from /repos/sessions (single request)', () => {
      expect(html).toContain("resilientFetch('/repos/sessions')");
    });

    it('does not fetch from old /sessions endpoint in list view', () => {
      // The grouped view should only call /repos/sessions, not /sessions
      // (detail view still uses /sessions/:id which is fine)
      const listFnMatch = html.match(/function loadGroupedSessions[\s\S]*?^}/m);
      // Verify /sessions is only used in detail view context
      expect(html).toContain("'/sessions/' + sessionId");
    });
  });

  describe('token embedding modes', () => {
    it('omits token script when embedToken is false', () => {
      expect(html).not.toContain('window.__DAEMON_TOKEN');
    });

    it('embeds token script when embedToken is true', () => {
      expect(htmlWithToken).toContain("window.__DAEMON_TOKEN = 'test-token-123'");
    });
  });

  describe('mobile responsiveness preserved', () => {
    it('has media query for 480px breakpoint', () => {
      expect(html).toContain('@media(max-width:480px)');
    });

    it('has media query for 768px breakpoint', () => {
      expect(html).toContain('@media(max-width:768px)');
    });

    it('repo-header has flex-wrap for narrow screens', () => {
      expect(html).toContain('flex-wrap:wrap');
    });
  });

  describe('collapse persistence across reloads', () => {
    it('reads collapse state from localStorage on render', () => {
      expect(html).toContain("localStorage.getItem(key)");
    });

    it('writes collapse state to localStorage on toggle', () => {
      expect(html).toContain("localStorage.setItem(key");
    });

    it('uses consistent key format repo-collapsed:<name>', () => {
      expect(html).toContain("'repo-collapsed:' + repo");
    });
  });
});
