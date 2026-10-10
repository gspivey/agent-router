<script lang="ts">
  /**
   * Per-entry shell (spa-overhaul Task 7 / ROADMAP 77).
   *
   * Wraps every rendered chat entry (bubble, card, pill) with:
   *  - the always-visible `JsonToggle` chip that pivots this entry between its
   *    rendered Svelte view and a raw-JSON `<pre>` (Requirement 8.1, 8.2);
   *  - a focusable container (`tabindex="0"`, Requirement 8.4) so assistive tech
   *    and keyboard users can land on each entry inside the `role="log"` region;
   *  - desktop-only (`≥1024 px`) keyboard handling: pressing `J` while this
   *    entry is focused toggles its JSON view (Requirement 8.5). The `?` help
   *    overlay is handled globally by `ChatView`.
   *
   * The toggle state is LOCAL to this component (`showJson`), so each entry
   * pivots independently (Requirement 8.2). Composing the toggle here — rather
   * than inside every leaf component — keeps leaves (notably the READ-ONLY
   * `PermissionCard`) free of their own buttons while still giving every entry a
   * JSON pivot. All colors reference the Requirement 1.7 custom properties
   * (Requirement 8.3). The JSON `<pre>` renders via Svelte text interpolation
   * (`textContent`), never a raw-HTML directive, preserving the v1 safe-rendering
   * boundary (NFR-6).
   */
  import type { Snippet } from 'svelte';
  import JsonToggle from './JsonToggle.svelte';

  interface Props {
    /** Pretty-printed raw entry JSON for the pivot view (Requirement 8.2). */
    json: string;
    /** The rendered (non-JSON) entry view. */
    children: Snippet;
  }

  const { json, children }: Props = $props();

  let showJson = $state(false);

  /** Toggle this entry's JSON pivot (Requirement 8.2). */
  export function toggle(): void {
    showJson = !showJson;
  }

  /** Desktop-only `J` key toggles the focused entry's JSON view (Req 8.5). */
  function onKeydown(event: KeyboardEvent): void {
    // Only on desktop (≥1024 px); ignore when typing in a field.
    if (typeof window !== 'undefined' && window.innerWidth < 1024) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.key === 'j' || event.key === 'J') {
      event.preventDefault();
      toggle();
    }
  }
</script>

<!--
  The entry is a focusable grouping (Req 8.4): keyboard users and assistive tech
  can land on it inside the role="log" region, and desktop `J` toggles its JSON
  (Req 8.5). It is intentionally a focusable non-widget container, so silence the
  non-interactive-interaction lint for this specific, intended pattern.
-->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  data-testid="chat-entry"
  data-json-open={showJson}
  tabindex="0"
  role="group"
  class="group relative w-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--tool-card-accent)]"
  onkeydown={onKeydown}
>
  <div class="pointer-events-none absolute right-1 top-1 z-10 opacity-100">
    <span class="pointer-events-auto">
      <JsonToggle active={showJson} onToggle={toggle} />
    </span>
  </div>

  {#if showJson}
    <pre
      data-testid="entry-json"
      class="my-1 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 pr-14 text-xs text-[var(--text-primary)]"
      style="overflow-wrap: anywhere;">{json}</pre>
  {:else}
    {@render children()}
  {/if}
</div>
