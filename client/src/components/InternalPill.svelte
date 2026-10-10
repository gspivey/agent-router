<script lang="ts">
  /**
   * Kiro-internal metadata pill (spa-overhaul Task 5 / ROADMAP 75).
   *
   * Minimized gray pill for an `internal` parsed entry (Requirement 6.6). It
   * shows the precomputed `text` (from `formatMetadataPill`, already assembled
   * by `parseStreamEntry`) and expands to reveal the full detail when activated.
   */
  interface Props {
    text: string;
  }

  const { text }: Props = $props();

  let expanded = $state(false);

  function toggle(): void {
    expanded = !expanded;
  }
</script>

<div data-testid="internal-pill" class="flex w-full justify-center">
  <button
    type="button"
    data-testid="internal-pill-toggle"
    aria-expanded={expanded}
    onclick={toggle}
    class="my-1 flex min-h-[44px] max-w-[85vw] items-center rounded-full bg-[var(--system-pill-bg)] px-3 py-1 text-xs text-[var(--text-muted)]"
  >
    {#if expanded}
      <span class="break-words text-left" style="overflow-wrap: anywhere;">{text}</span>
    {:else}
      <span class="truncate">{text}</span>
    {/if}
  </button>
</div>
