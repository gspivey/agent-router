<script lang="ts">
  /**
   * Skeleton placeholder bubble (spa-overhaul Task 6 / ROADMAP 76).
   *
   * Rendered by `ChatView` while the historical-entries fetch is in flight
   * (Requirement 7.5); replaced by the rendered entries once the fetch resolves.
   * Right-aligned to mirror the agent `MessageBubble` layout so the transition
   * from skeleton → content does not jump. Purely presentational; all colors
   * reference the Requirement 1.7 custom properties (no hardcoded hex — 8.3).
   */
  interface Props {
    /** Relative width of the placeholder (CSS width value). Defaults to 60%. */
    width?: string;
  }

  const { width = '60%' }: Props = $props();
</script>

<div data-testid="skeleton-bubble" class="flex w-full justify-end" aria-hidden="true">
  <div
    class="my-1 h-8 max-w-[85vw] animate-pulse rounded-2xl bg-[var(--surface)] md:max-w-[70%]"
    style="width: {width};"
  ></div>
</div>
