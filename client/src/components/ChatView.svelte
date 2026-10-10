<script lang="ts">
  /**
   * Chat (detail) view — historical render only (spa-overhaul Task 5 / ROADMAP 75).
   *
   * Fetches the session history via `api.getSession(id, 200)` (capturing
   * `entries`, `meta`, `first_event_id`, `last_event_id`), normalizes each raw
   * entry with `parseStreamEntry` from `@shared/logic`, folds it into the
   * renderable item list (`buildRenderItems`), and renders each kind with its
   * dedicated Svelte component in ascending event-`id` order (Requirement 6.1,
   * 6.9). Rendering is Svelte-native from the `ParsedEntry` union — the DOM-
   * mutation `renderStreamEntry` from `web-ui.ts` is deliberately NOT reused.
   *
   * Live SSE streaming, the streaming cursor, tool spinners, the composer, and
   * the interrupt control all land in Task 6; this task is historical-only, so a
   * completed-session load shows no cursor and no spinners.
   */
  import { onMount } from 'svelte';
  import { api, AuthError } from '../lib/api.js';
  import { parseStreamEntry } from '../lib/logic.js';
  import { buildRenderItems, type RenderItem } from '../lib/chat-render.js';
  import type { StreamEntry } from '../lib/types.js';
  import { goToList } from '../routes/router.svelte.js';
  import MessageBubble from './MessageBubble.svelte';
  import SystemPill from './SystemPill.svelte';
  import ToolCallCard from './ToolCallCard.svelte';
  import PermissionCard from './PermissionCard.svelte';
  import InternalPill from './InternalPill.svelte';
  import UnknownPill from './UnknownPill.svelte';

  interface Props {
    sessionId: string;
  }

  const { sessionId }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let items = $state<RenderItem[]>([]);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const detail = await api.getSession(sessionId, 200);
      const raw = detail.entries as StreamEntry[];
      // Derive each entry's SSE id as first_event_id + i (contiguous broker
      // ids, Requirement 10); fall back to the index when the slice is empty.
      const base = detail.first_event_id;
      const ids = base !== null ? raw.map((_, i) => base + i) : raw.map((_, i) => i);
      const parsed = raw.map((e) => parseStreamEntry(e));
      items = buildRenderItems(parsed, ids);
    } catch (err) {
      if (!(err instanceof AuthError)) {
        error = 'Could not load session.';
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<section data-testid="chat-view" class="flex min-h-screen flex-col">
  <div class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
    <button
      type="button"
      data-testid="back-to-list"
      onclick={goToList}
      class="min-h-[44px] rounded border border-[var(--border)] bg-[var(--surface)] px-4 text-sm text-[var(--text-primary)]"
    >
      ← Sessions
    </button>
    <span class="min-w-0 flex-1 truncate text-sm text-[var(--text-muted)]">{sessionId}</span>
  </div>

  <div
    data-testid="chat-log"
    class="flex flex-1 flex-col gap-0.5 overflow-x-hidden px-3 py-3"
  >
    {#if loading}
      <p data-testid="chat-loading" class="p-4 text-sm text-[var(--text-muted)]">Loading session…</p>
    {:else if error}
      <div data-testid="chat-error" class="flex flex-col items-start gap-3 p-4">
        <p class="m-0 text-sm text-[var(--error)]">{error}</p>
        <button
          type="button"
          data-testid="chat-retry"
          onclick={load}
          class="min-h-[44px] rounded border border-[var(--border)] bg-[var(--surface)] px-4 text-sm text-[var(--text-primary)]"
        >
          Retry
        </button>
      </div>
    {:else if items.length === 0}
      <p data-testid="chat-empty" class="p-4 text-sm text-[var(--text-muted)]">No activity yet.</p>
    {:else}
      {#each items as item (item.key)}
        {#if item.kind === 'bubble'}
          <MessageBubble text={item.text} />
        {:else if item.kind === 'system'}
          <SystemPill text={item.text} badge={item.badge} />
        {:else if item.kind === 'tool_call'}
          <ToolCallCard title={item.title} updates={item.updates} collapsed={true} />
        {:else if item.kind === 'permission'}
          <PermissionCard title={item.title} />
        {:else if item.kind === 'internal'}
          <InternalPill text={item.text} />
        {:else}
          <UnknownPill typeLabel={item.typeLabel} />
        {/if}
      {/each}
    {/if}
  </div>
</section>
