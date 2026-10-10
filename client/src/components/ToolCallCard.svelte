<script lang="ts">
  /**
   * Tool-call card (spa-overhaul Task 5 / ROADMAP 75).
   *
   * Full-width collapsible card for a `tool_call` parsed entry (Requirement
   * 6.4). The header shows the tool title; the body shows the concatenated text
   * of every `tool_update` entry that shares this card's `toolCallId`, joined by
   * the caller (`ChatView`) and passed in as `updates`.
   *
   * Below 768 px the card renders collapsed by default (Requirement 6.8); the
   * operator expands it by activating the header. On wider viewports it starts
   * expanded. The streaming spinner (Requirement 7.3) is NOT part of this
   * historical-only task — it lands with live SSE in Task 6.
   */
  import { untrack } from 'svelte';

  interface Props {
    title: string;
    /** Concatenated `tool_update` body text keyed to this card's toolCallId. */
    updates: string;
    /** Start collapsed (true on mobile). Defaults to false (expanded). */
    collapsed?: boolean;
  }

  const { title, updates, collapsed = false }: Props = $props();

  // One-time initial expanded state: collapsed on mobile, expanded otherwise.
  // `collapsed` seeds local state exactly once (it is an initial default, not a
  // reactive binding), so read it untracked.
  let open = $state(untrack(() => !collapsed));

  function toggle(): void {
    open = !open;
  }
</script>

<div
  data-testid="tool-call-card"
  class="my-1 w-full overflow-hidden rounded-lg border border-[var(--tool-card-accent)] bg-[var(--tool-card-bg)]"
>
  <button
    type="button"
    data-testid="tool-call-header"
    aria-expanded={open}
    onclick={toggle}
    class="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-[var(--tool-card-accent)]"
  >
    <span aria-hidden="true" class="text-xs">{open ? '▾' : '▸'}</span>
    <span class="min-w-0 flex-1 truncate">{title}</span>
  </button>
  {#if open && updates}
    <pre
      data-testid="tool-call-body"
      class="m-0 max-w-full overflow-x-auto whitespace-pre-wrap break-words border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--text-primary)]"
      style="overflow-wrap: anywhere;">{updates}</pre>
  {/if}
</div>
