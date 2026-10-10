<script lang="ts">
  /**
   * Unknown-entry pill (spa-overhaul Task 5 / ROADMAP 75).
   *
   * Gray pill for an `unknown` parsed entry (Requirement 6.7). It shows ONLY the
   * entry's `typeLabel` and never renders the raw payload content, mirroring the
   * no-leak guarantee in `parseStreamEntry` (which withholds the raw body from
   * the `unknown` fallback).
   */
  interface Props {
    typeLabel: string;
  }

  const { typeLabel }: Props = $props();
</script>

<div data-testid="unknown-pill" class="flex w-full justify-center">
  <span
    class="my-1 max-w-[85vw] truncate rounded-full bg-[var(--system-pill-bg)] px-3 py-1 text-xs text-[var(--text-muted)]"
  >{typeLabel}</span>
</div>
