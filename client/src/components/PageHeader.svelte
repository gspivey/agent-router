<script lang="ts">
  /**
   * Page heading shared primitive (spa-polish ROADMAP 87, Req 4.2).
   *
   * Renders an `<h1>` title and an optional subtitle for the top of each view.
   * All colors reference `app.css` tokens (NFR-2).
   */
  interface Props {
    title: string;
    subtitle?: string;
  }

  const { title, subtitle }: Props = $props();
</script>

<div data-testid="page-header" class="mb-6">
  <h1 class="m-0 text-xl font-semibold text-[var(--text-primary)]">{title}</h1>
  {#if subtitle}
    <p data-testid="page-header-subtitle" class="mt-1 text-sm text-[var(--text-muted)]">
      {subtitle}
    </p>
  {/if}
</div>
