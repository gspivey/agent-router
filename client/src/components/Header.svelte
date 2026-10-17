<script lang="ts">
  /**
   * Top header for the SPA (spa-polish ROADMAP 88, Req 10).
   *
   * Renders, on the left, an inline router/branch glyph + "Agent Router"
   * branding (linking to `#/`) and the build version from `__APP_VERSION__`.
   * The nav holds three tabs — Overview (`#/`), Sessions (`#/sessions`), and
   * Config (`#/config`). The active tab uses an accent underline (replacing the
   * previous elevated-surface background), carries `aria-current="page"`, and
   * all interactive elements expose a visible focus ring. The header stays
   * sticky and uses a translucent backdrop-blur background via `--header-bg`
   * (an RGB-channel token, since Tailwind 3 opacity modifiers do not work on
   * hex-valued CSS variables).
   */
  import { route } from '../routes/router.svelte.js';

  // Sessions covers both the list and an individual session's detail view.
  const overviewActive = $derived(route.current.view === 'overview');
  const sessionsActive = $derived(
    route.current.view === 'list' || route.current.view === 'detail',
  );
  const configActive = $derived(route.current.view === 'config');

  /** Shared tab classes; the active variant swaps in the accent underline. */
  const BASE_TAB =
    'rounded-t px-3 py-2 text-sm font-medium transition-colors ' +
    'focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none';
  const ACTIVE_TAB = 'border-b-2 border-[var(--accent)] text-[var(--text-primary)]';
  const INACTIVE_TAB = 'text-[var(--text-muted)] hover:text-[var(--text-primary)]';

  function tabClass(active: boolean): string {
    return `${BASE_TAB} ${active ? ACTIVE_TAB : INACTIVE_TAB}`;
  }
</script>

<header
  data-testid="app-header"
  class="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-[var(--border)]
         bg-[var(--header-bg)] px-4 backdrop-blur-sm"
>
  <a
    href="#/"
    data-testid="brand-link"
    aria-label="Agent Router home"
    class="flex items-center gap-2 rounded focus-visible:ring-2
           focus-visible:ring-[var(--accent)] focus-visible:outline-none"
  >
    <svg
      data-testid="brand-glyph"
      aria-hidden="true"
      class="h-5 w-5 text-[var(--accent)]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <!-- A simple branch/route glyph drawn with currentColor. -->
      <circle cx="6" cy="6" r="2.5"></circle>
      <circle cx="6" cy="18" r="2.5"></circle>
      <circle cx="18" cy="12" r="2.5"></circle>
      <path d="M6 8.5v7"></path>
      <path d="M8.5 6h4a3 3 0 0 1 3 3v0a3 3 0 0 1-3 3h-4"></path>
    </svg>
    <span class="text-sm font-semibold text-[var(--text-primary)]">Agent Router</span>
    <span data-testid="app-version" class="text-xs text-[var(--text-muted)]">v{__APP_VERSION__}</span>
  </a>

  <nav aria-label="Main navigation" class="flex items-center gap-1">
    <a
      href="#/"
      data-testid="nav-overview"
      aria-current={overviewActive ? 'page' : undefined}
      class={tabClass(overviewActive)}
    >
      Overview
    </a>
    <a
      href="#/sessions"
      data-testid="nav-sessions"
      aria-current={sessionsActive ? 'page' : undefined}
      class={tabClass(sessionsActive)}
    >
      Sessions
    </a>
    <a
      href="#/config"
      data-testid="nav-config"
      aria-current={configActive ? 'page' : undefined}
      class={tabClass(configActive)}
    >
      Config
    </a>
  </nav>
</header>
