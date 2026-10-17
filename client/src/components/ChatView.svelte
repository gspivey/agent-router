<script lang="ts">
  /**
   * Chat (detail) view — live SSE streaming, streaming states, operator controls
   * (spa-overhaul Task 6 / ROADMAP 76; builds on the Task 5 historical renderer).
   *
   * Flow:
   *  - Fetch history via `api.getSession(id, 200)` (`entries`, `meta`,
   *    `first_event_id`, `last_event_id`); render skeleton bubbles while in
   *    flight (Req 7.5).
   *  - Derive each entry's SSE id as `first_event_id + i` (contiguous broker
   *    ids, Req 10) and seed the merged entry map.
   *  - For `meta.status === 'active'` sessions, open the SSE stream via
   *    `connectStream`, seeding the first `Last-Event-ID` from `last_event_id`
   *    (Req 7.1 / 4.3); append incoming entries merged by id (Req 4.4), show the
   *    reconnect pill on `reconnecting` (Req 7.4), and close the stream on
   *    `onDestroy`, on an `expired` fatal, and on `session_ended` (Req 4.6).
   *  - Streaming states: the pulsing `▌` cursor on the active agent bubble while
   *    a turn streams (Req 7.2), the in-progress spinner on unfinished tool-call
   *    cards (Req 7.3) — both derived by the pure `streaming-state` helpers.
   *  - Operator controls: an always-visible `Composer` (inject, Req 7.6) and the
   *    `DetailBar` Interrupt control (Req 7.7). On `session_ended` the ended pill
   *    is appended, cursor/spinners vanish, and both controls go inert (Req 7.8).
   *  - Auto-scroll to the bottom on new entries unless the operator scrolled up
   *    >100 px, in which case a "↓ New messages" badge appears (Req 7.1 / HIGH-13).
   *
   * Rendering stays Svelte-native from the `ParsedEntry` union — the DOM-mutation
   * `renderStreamEntry` from `web-ui.ts` is deliberately NOT reused. Agent
   * bubbles, prompt, system, and error rows render through the unified
   * `MessageRow` grammar (spa-polish ROADMAP 88); agent markdown is delegated to
   * the single sanctioned sanitized-markdown sink inside `MessageBubble` (`bare`
   * mode). Tool calls, permissions, internal metadata, and skeletons keep their
   * dedicated components.
   */
  import { onMount, onDestroy, tick } from 'svelte';
  import { api, AuthError } from '../lib/api.js';
  import { auth, enterExpiredState, registerAbortHandler } from '../lib/stores.svelte.js';
  import { parseStreamEntry, mergeEvents, groupLabelVisible, type SSEEvent, type RowIdentity } from '../lib/logic.js';
  import { buildRenderItems, type RenderItem } from '../lib/chat-render.js';
  import {
    shouldShowCursor,
    finishedToolCallIds,
    shouldShowSpinner,
  } from '../lib/streaming-state.js';
  import { connectStream, type SseHandle } from '../lib/sse.js';
  import type { SessionStatus, StreamEntry, SessionMeta } from '../lib/types.js';
  import MessageRow from './MessageRow.svelte';
  import ToolCallCard from './ToolCallCard.svelte';
  import PermissionCard from './PermissionCard.svelte';
  import InternalPill from './InternalPill.svelte';
  import UnknownPill from './UnknownPill.svelte';
  import SkeletonBubble from './SkeletonBubble.svelte';
  import ReconnectPill from './ReconnectPill.svelte';
  import Composer from './Composer.svelte';
  import DetailBar from './DetailBar.svelte';
  import SessionMetaPanel from './SessionMeta.svelte';
  import EntryShell from './EntryShell.svelte';
  import HelpOverlay from './HelpOverlay.svelte';

  interface Props {
    sessionId: string;
  }

  const { sessionId }: Props = $props();

  type Connection = 'live' | 'reconnecting';

  let loading = $state(true);
  let error = $state<string | null>(null);
  // The session metadata loaded from `api.getSession`, for the metadata panel
  // (spa-operator-restoration B-6). Null until the first successful load.
  let meta = $state<SessionMeta | null>(null);
  // "Show internals" toggle (B-7 / FR-4). Persisted under `ar-show-internals`.
  let showInternals = $state(
    typeof localStorage !== 'undefined' && localStorage.getItem('ar-show-internals') === '1',
  );
  // Merged (id, data) entries, kept sorted ascending by id for exactly-once
  // rendering across reconnects (Req 4.4, 6.9).
  let events = $state<SSEEvent[]>([]);
  let status = $state<SessionStatus>('active');
  let connection = $state<Connection>('live');
  let ended = $state(false);
  // Auto-scroll affordance (Req 7.1 / HIGH-13).
  let newMessages = $state(false);
  // Keyboard-shortcut help overlay (Req 8.5) — desktop (≥1024 px) only.
  let helpOpen = $state(false);

  /**
   * Global `?` opens the keyboard-shortcut help overlay on desktop viewports
   * (≥1024 px, Req 8.5). `J` is handled per-entry by `EntryShell` on the focused
   * entry. Keys typed into the Composer input are ignored here.
   */
  function onWindowKeydown(event: KeyboardEvent): void {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (event.key === '?') {
      event.preventDefault();
      helpOpen = true;
    }
  }

  let sse: SseHandle | null = null;
  let deregisterAbort: (() => void) | null = null;
  let logEl: HTMLDivElement | null = $state(null);
  let highestId = 0;

  // `SSEEvent.data` is typed as `string` in the shared logic, but the SSE client
  // delivers already-parsed JSON objects. We store the raw entry object as data
  // and re-cast on read; the id is what matters for dedup.
  const rawEntries = $derived(events.map((e) => e.data as unknown as StreamEntry));
  const ids = $derived(events.map((e) => e.id));
  const parsed = $derived(rawEntries.map((e) => parseStreamEntry(e)));
  const items = $derived<RenderItem[]>(buildRenderItems(parsed, ids, rawEntries));

  // "Show internals" filter (B-7 / FR-4.1): when OFF, drop entries whose raw
  // `source` begins with `_kiro.dev/`. The toggle flips this live with no reload.
  const visibleItems = $derived<RenderItem[]>(
    showInternals ? items : items.filter((item) => !item.rawSource?.startsWith('_kiro.dev/')),
  );

  // Streaming-state derivations (pure, Req 7.2 / 7.3).
  const cursorVisible = $derived(shouldShowCursor(rawEntries, status));
  const finishedTools = $derived(finishedToolCallIds(rawEntries));
  // The index of the LAST agent bubble — the cursor attaches there only.
  const lastBubbleIndex = $derived.by(() => {
    for (let i = visibleItems.length - 1; i >= 0; i--) {
      if (visibleItems[i]?.kind === 'bubble') return i;
    }
    return -1;
  });

  const controlsDisabled = $derived(ended || status !== 'active');

  /**
   * Per-visible-item row metadata for the unified `MessageRow` grammar
   * (spa-polish ROADMAP 88, Req 11.4). For the two kinds `MessageRow` renders —
   * agent bubbles and system rows — compute the `(kind, label)` identity, derive
   * `showLabel` via `groupLabelVisible` on the previous MessageRow identity, and
   * pick the vertical margin: the first row of a group gets `mt-4` (inter-group),
   * subsequent same-group rows get `mt-1` (intra-group). Non-MessageRow items
   * (tool/permission/internal/unknown) reset the grouping chain.
   */
  const rowMeta = $derived.by(() => {
    const metas: { showLabel: boolean; margin: string }[] = [];
    let prev: RowIdentity | null = null;
    for (const item of visibleItems) {
      let identity: RowIdentity | null = null;
      if (item.kind === 'bubble') identity = { kind: 'agent', label: 'Agent' };
      else if (item.kind === 'system') identity = { kind: 'system', label: '' };

      if (identity === null) {
        // A non-MessageRow item breaks the group chain.
        metas.push({ showLabel: true, margin: 'mt-4' });
        prev = null;
        continue;
      }
      const show = groupLabelVisible(prev, identity);
      metas.push({ showLabel: show, margin: show ? 'mt-4' : 'mt-1' });
      prev = identity;
    }
    return metas;
  });

  function mergeIncoming(incoming: SSEEvent[]): void {
    events = mergeEvents(events, incoming);
    for (const e of incoming) if (e.id > highestId) highestId = e.id;
  }

  function onNewEntry(): void {
    void maybeAutoScroll();
  }

  async function maybeAutoScroll(): Promise<void> {
    await tick();
    const el = logEl;
    if (el === null) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Within 100px of the bottom → stick to the bottom (Req 7.1 / HIGH-13).
    if (distanceFromBottom <= 100) {
      el.scrollTop = el.scrollHeight;
      newMessages = false;
    } else {
      newMessages = true;
    }
  }

  function scrollToBottom(): void {
    const el = logEl;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    newMessages = false;
  }

  function closeStream(): void {
    sse?.close();
    sse = null;
    deregisterAbort?.();
    deregisterAbort = null;
  }

  function openStream(firstEventId: number | null): void {
    const token = auth.token;
    if (token === null) return;
    const handle = connectStream({
      sessionId,
      token,
      firstEventId,
      onEntry: (id, data) => {
        mergeIncoming([{ id, data: data as unknown as string }]);
        onNewEntry();
      },
      onEnded: () => {
        // Append the ended system pill, hide cursor/spinners, disable controls.
        ended = true;
        status = 'completed';
        connection = 'live';
        mergeIncoming([
          {
            id: highestId + 1,
            data: {
              ts: new Date().toISOString(),
              source: 'router',
              type: 'session_ended',
              reason: 'ended',
            } as unknown as string,
          },
        ]);
        onNewEntry();
        closeStream();
      },
      onStatus: (s) => {
        connection = s;
      },
      onFatal: (kind) => {
        if (kind === 'expired') {
          enterExpiredState();
        } else {
          // 404 "not found" / 410 "ended": stop streaming, treat as inactive.
          ended = true;
          status = kind === 'ended' ? 'completed' : status;
        }
        closeStream();
      },
    });
    sse = handle;
    // Register the handle so the global 401/403 lockout can abort it (Req 3.4).
    deregisterAbort = registerAbortHandler(handle.close);
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    ended = false;
    try {
      const detail = await api.getSession(sessionId, 200);
      const raw = detail.entries as StreamEntry[];
      const base = detail.first_event_id;
      // Contiguous broker ids: id of entry i is first_event_id + i (Req 10).
      const seeded: SSEEvent[] =
        base !== null
          ? raw.map((e, i) => ({ id: base + i, data: e as unknown as string }))
          : raw.map((e, i) => ({ id: i, data: e as unknown as string }));
      events = mergeEvents([], seeded);
      highestId = detail.last_event_id ?? (seeded.length > 0 ? seeded[seeded.length - 1]!.id : 0);
      status = detail.meta.status;
      meta = detail.meta;
      loading = false;

      // Only live sessions open a stream (Req 7.1); a completed/abandoned/failed
      // history load stays static — no cursor, no spinners (Req 7.2, 7.3).
      if (detail.meta.status === 'active') {
        connection = 'live';
        openStream(detail.last_event_id);
      }
      await maybeAutoScroll();
    } catch (err) {
      loading = false;
      if (!(err instanceof AuthError)) {
        error = 'Could not load session.';
      }
    }
  }

  async function sendPrompt(prompt: string): Promise<void> {
    await api.inject(sessionId, prompt);
  }

  async function interrupt(): Promise<void> {
    await api.interrupt(sessionId);
    // Re-fetch meta to reflect the updated status; do NOT assume the session
    // ended (Req 7.7 / HIGH-6).
    try {
      const detail = await api.getSession(sessionId, 1);
      status = detail.meta.status;
      if (status !== 'active') ended = true;
    } catch {
      // Leave status as-is on a transient re-fetch failure.
    }
  }

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    closeStream();
  });

  const sessionTitle = $derived(sessionId);
</script>

<svelte:window onkeydown={onWindowKeydown} />

<section data-testid="chat-view" class="flex h-[calc(100dvh-3.5rem)] flex-col">
  <div class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
    <span class="min-w-0 flex-1 truncate text-sm text-[var(--text-muted)]">{sessionId}</span>
    <label
      class="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-[var(--text-muted)]"
    >
      <input
        type="checkbox"
        data-testid="show-internals-toggle"
        bind:checked={showInternals}
        onchange={() => {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('ar-show-internals', showInternals ? '1' : '');
          }
        }}
      />
      Show internals
    </label>
    {#if connection === 'reconnecting' && !ended}
      <span class="text-xs text-[var(--warning)]">reconnecting</span>
    {/if}
  </div>

  {#if meta !== null}
    <SessionMetaPanel {meta} />
  {/if}

  {#if connection === 'reconnecting' && !ended}
    <ReconnectPill />
  {/if}

  <div
    bind:this={logEl}
    data-testid="chat-log"
    role="log"
    aria-live="polite"
    class="relative flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-3 py-3"
  >
    {#if loading}
      <div data-testid="chat-skeletons">
        <SkeletonBubble width="55%" />
        <SkeletonBubble width="70%" />
        <SkeletonBubble width="40%" />
      </div>
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
    {:else if visibleItems.length === 0}
      <p data-testid="chat-empty" class="p-4 text-sm text-[var(--text-muted)]">No activity yet.</p>
    {:else}
      {#each visibleItems as item, i (item.key)}
        <EntryShell json={item.json}>
          {#if item.kind === 'bubble'}
            <div class={rowMeta[i]?.margin ?? 'mt-4'}>
              <MessageRow
                kind="agent"
                text={item.text}
                showLabel={rowMeta[i]?.showLabel ?? true}
                cursor={cursorVisible && i === lastBubbleIndex}
              />
            </div>
          {:else if item.kind === 'system'}
            <div class={rowMeta[i]?.margin ?? 'mt-4'}>
              <MessageRow kind="system" text={item.text} showLabel={false} />
            </div>
          {:else if item.kind === 'tool_call'}
            <ToolCallCard
              title={item.title}
              updates={item.updates}
              collapsed={true}
              spinner={shouldShowSpinner(item.toolCallId, finishedTools, status)}
            />
          {:else if item.kind === 'permission'}
            <PermissionCard title={item.title} />
          {:else if item.kind === 'internal'}
            <InternalPill text={item.text} />
          {:else}
            <UnknownPill typeLabel={item.typeLabel} />
          {/if}
        </EntryShell>
      {/each}
    {/if}
  </div>

  {#if newMessages}
    <div class="pointer-events-none flex w-full justify-center">
      <button
        type="button"
        data-testid="new-messages-badge"
        onclick={scrollToBottom}
        class="pointer-events-auto -mt-10 mb-2 min-h-[44px] rounded-full bg-[var(--agent-bubble-bg)] px-4 text-xs font-medium text-[var(--agent-bubble-text)]"
      >
        ↓ New messages
      </button>
    </div>
  {/if}

  <Composer onSend={sendPrompt} disabled={controlsDisabled} />
  <DetailBar
    title={sessionTitle}
    sessionId={sessionId}
    status={status}
    onInterrupt={interrupt}
    disabled={controlsDisabled}
  />

  {#if helpOpen}
    <HelpOverlay onClose={() => (helpOpen = false)} />
  {/if}
</section>
