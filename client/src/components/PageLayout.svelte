<script lang="ts">
  /**
   * Centered max-width + gutter layout wrapper (spa-polish ROADMAP 87, Req 5.3).
   *
   * `wide` (default) — used by list, config, and overview views — applies
   * horizontal gutters, vertical padding, and a 6xl max width. `narrow` — used
   * by the chat (`detail`) view — applies gutters and a 4xl max width but NO
   * vertical padding, because `py-6` would push the chat composer below the fold
   * (Req 5.2). All classes are static Tailwind utilities (NFR-2).
   */
  import type { Snippet } from 'svelte';

  interface Props {
    width?: 'wide' | 'narrow';
    children: Snippet;
  }

  const { width = 'wide', children }: Props = $props();

  const cls = $derived(
    width === 'narrow'
      ? 'max-w-4xl mx-auto px-4 sm:px-6 lg:px-8'
      : 'max-w-6xl mx-auto px-4 py-6 sm:px-6 lg:px-8',
  );
</script>

<div data-testid="page-layout" data-width={width} class={cls}>
  {@render children()}
</div>
