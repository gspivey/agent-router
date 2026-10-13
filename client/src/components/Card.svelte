<script lang="ts">
  /**
   * Reusable surface wrapper shared primitive (spa-polish ROADMAP 87, Req 4.1).
   *
   * A rounded, bordered surface with padding and a default slot for its
   * contents. All colors reference `app.css` tokens (NFR-2).
   */
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }

  const { children }: Props = $props();
</script>

<div
  data-testid="card"
  class="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
>
  {@render children()}
</div>
