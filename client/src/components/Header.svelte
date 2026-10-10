<script lang="ts">
  /**
   * Top header for the SPA (spa-overhaul Task 4 / ROADMAP 74).
   *
   * A single-row header showing only the "Sessions" title. It is shown at ALL
   * viewport tiers (mobile, tablet, desktop) — there is NO tab bar and NO Repos
   * or Config navigation entries (Requirement 5.3, 5.4, 5.8). The SPA has one
   * navigation destination.
   */
</script>

<header
  data-testid="app-header"
  class="sticky top-0 z-10 flex h-14 items-center border-b border-[var(--border)] bg-[var(--surface)] px-4"
>
  <h1 class="m-0 text-base font-semibold text-[var(--text-primary)]">Sessions</h1>
</header>
