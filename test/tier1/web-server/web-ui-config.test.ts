import { describe, it, expect } from 'vitest';
import { renderWebUI } from '../../../src/web-ui.js';

describe('renderWebUI config view features', () => {
  const html = renderWebUI({ embedToken: true, token: 'test-token-123' });

  describe('Task 4: Config tab navigation', () => {
    it('contains Config nav link with #config href', () => {
      expect(html).toContain('href="#config"');
      expect(html).toContain('class="nav-link"');
      expect(html).toContain('data-view="config"');
      expect(html).toContain('>Config<');
    });

    it('contains Sessions nav link with data-view attribute', () => {
      expect(html).toContain('data-view="sessions"');
      expect(html).toContain('>Sessions<');
    });

    it('contains config-view container div', () => {
      expect(html).toContain('id="config-view"');
    });

    it('config-view is hidden by default', () => {
      expect(html).toContain('id="config-view" style="display:none"');
    });

    it('parseHashRoute handles #config route', () => {
      expect(html).toContain("trimmed === 'config'");
      expect(html).toContain("view: 'config'");
    });

    it('navigate function handles config view', () => {
      expect(html).toContain("route.view === 'config'");
      expect(html).toContain('loadConfig()');
    });

    it('updates nav active state on navigation', () => {
      expect(html).toContain('classList.remove(\'active\')');
      expect(html).toContain('classList.add(\'active\')');
    });
  });

  describe('Task 5: Config tab rendering logic', () => {
    it('contains loadConfig function that fetches /config', () => {
      expect(html).toContain('function loadConfig()');
      expect(html).toContain("resilientFetch('/config')");
    });

    it('contains renderConfigView function', () => {
      expect(html).toContain('function renderConfigView(data)');
    });

    it('renders session timeouts section', () => {
      expect(html).toContain('Session Timeouts');
      expect(html).toContain('data.sessionTimeouts.inactivityMinutes');
      expect(html).toContain('data.sessionTimeouts.maxLifetimeMinutes');
      expect(html).toContain('data.sessionTimeouts.gracePeriodAfterMergeSeconds');
    });

    it('renders rate limits section', () => {
      expect(html).toContain('Rate Limits');
      expect(html).toContain('data.rateLimits.perPRSeconds');
    });

    it('renders cron schedules table', () => {
      expect(html).toContain('Cron Schedules');
      expect(html).toContain('cron.name');
      expect(html).toContain('cron.repo');
      expect(html).toContain('cron.schedule');
      expect(html).toContain('formatNextFire(cron.nextFireTime)');
      expect(html).toContain('cron.paused');
    });

    it('renders token health table with health dots', () => {
      expect(html).toContain('Token Health');
      expect(html).toContain('token.project');
      expect(html).toContain('token.tokenName');
      expect(html).toContain('healthDot(token.health)');
      expect(html).toContain('token.expiry');
    });

    it('renders repositories table', () => {
      expect(html).toContain('Repositories');
      expect(html).toContain('repo.name');
      expect(html).toContain('repo.webhookSecretName');
    });

    it('contains formatNextFire using Intl.DateTimeFormat', () => {
      expect(html).toContain('function formatNextFire(isoString)');
      expect(html).toContain('Intl.DateTimeFormat');
    });

    it('contains healthDot helper function', () => {
      expect(html).toContain('function healthDot(health)');
      expect(html).toContain('health-green');
      expect(html).toContain('health-red');
      expect(html).toContain('health-unknown');
    });

    it('contains error state rendering with retry button', () => {
      expect(html).toContain('retry-config-btn');
      expect(html).toContain('Failed to load configuration');
    });

    it('contains auth error rendering for config', () => {
      // In loadConfig, auth errors are shown
      expect(html).toContain("result.outcome === 'auth'");
    });

    it('shows empty state when no crons configured', () => {
      expect(html).toContain('No cron schedules configured');
    });

    it('shows empty state when no tokens configured', () => {
      expect(html).toContain('No tokens configured');
    });

    it('shows empty state when no repos configured', () => {
      expect(html).toContain('No repositories configured');
    });

    it('uses escapeHtml for user-provided data', () => {
      expect(html).toContain('escapeHtml(cron.name)');
      expect(html).toContain('escapeHtml(cron.repo)');
      expect(html).toContain('escapeHtml(token.project)');
      expect(html).toContain('escapeHtml(repo.name)');
    });
  });

  describe('Task 6: Config tab CSS styles', () => {
    it('contains .config-grid class for side-by-side layout', () => {
      expect(html).toContain('.config-grid');
      expect(html).toContain('grid-template-columns:1fr 1fr');
    });

    it('contains .config-card class for section cards', () => {
      expect(html).toContain('.config-card');
    });

    it('contains .health-green class', () => {
      expect(html).toContain('.health-green');
      expect(html).toContain('#3fb950');
    });

    it('contains .health-red class', () => {
      expect(html).toContain('.health-red');
      expect(html).toContain('#f85149');
    });

    it('contains .health-unknown class', () => {
      expect(html).toContain('.health-unknown');
    });

    it('contains .health-dot base class', () => {
      expect(html).toContain('.health-dot');
      expect(html).toContain('border-radius:50%');
    });

    it('contains badge-paused variant', () => {
      expect(html).toContain('.badge-paused');
    });

    it('contains badge-active variant', () => {
      expect(html).toContain('.badge-active');
    });

    it('config-grid collapses to single column on mobile', () => {
      // Check media query for .config-grid responsive behavior
      expect(html).toContain('@media(max-width:768px){.config-grid{grid-template-columns:1fr}.repo-header{padding:12px}}');
    });

    it('config-card matches existing dark theme (background + border)', () => {
      expect(html).toContain('.config-card{');
      expect(html).toContain('background:#0d1117');
      expect(html).toContain('border:1px solid #30363d');
      expect(html).toContain('border-radius:8px');
    });
  });

  describe('Task 7: Integration checks (no page reload on navigation)', () => {
    it('uses hashchange event for navigation, no full page reload', () => {
      expect(html).toContain("window.addEventListener('hashchange', navigate)");
    });

    it('does not contain any form action or page-navigation submit', () => {
      expect(html).not.toContain('action=');
      expect(html).not.toContain('method="POST"');
    });

    it('config view uses same auth mechanism as sessions', () => {
      // Both use resilientFetch which includes Authorization header
      expect(html).toContain("resilientFetch('/config')");
    });

    it('no secret values are rendered client-side (only names)', () => {
      // The renderer shows webhookSecretName (the name), never a value
      expect(html).toContain('repo.webhookSecretName');
      // It does NOT try to display any raw token values
      expect(html).not.toContain('token.value');
      expect(html).not.toContain('token.secret');
    });
  });
});
