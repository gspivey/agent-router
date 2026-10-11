<script lang="ts">
  /**
   * Top header for the SPA.
   *
   * Renders a two-item navigation bar — "Sessions" (`#/`) and "Config"
   * (`#/config`) — restoring the operator Config destination
   * (spa-operator-restoration ROADMAP 80, Task A-8). The active item is visually
   * distinguished with the elevated-surface background from the GitHub dark
   * palette.
   */
  import { route } from '../routes/router.svelte.js';
</script>

<header
  data-testid="app-header"
  class="sticky top-0 z-10 flex h-14 items-center border-b border-[var(--border)] bg-[var(--surface)] px-4"
>
  <nav aria-label="Main navigation" class="flex items-center gap-1">
    <a
      href="#/"
      data-testid="nav-sessions"
      class="rounded px-3 py-2 text-sm font-medium transition-colors
             {route.current.view === 'list'
               ? 'bg-[var(--system-pill-bg)] text-[var(--text-primary)]'
               : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
    >
      Sessions
    </a>
    <a
      href="#/config"
      data-testid="nav-config"
      class="rounded px-3 py-2 text-sm font-medium transition-colors
             {route.current.view === 'config'
               ? 'bg-[var(--system-pill-bg)] text-[var(--text-primary)]'
               : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}"
    >
      Config
    </a>
  </nav>
</header>
