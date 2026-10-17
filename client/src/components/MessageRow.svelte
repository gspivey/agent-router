<script lang="ts">
  /**
   * Unified chat message row (spa-polish ROADMAP 88, Req 11).
   *
   * The single row component `ChatView` uses for the four message-bubble kinds:
   * `agent`, `prompt`/user, `system`, and `error`. Tool calls
   * (`ToolCallCard.svelte`), permission requests (`PermissionCard.svelte`),
   * internal metadata (`InternalPill`), and loading skeletons (`SkeletonBubble`)
   * are rendered by their own components and are NOT handled here — this keeps
   * `RowKind` a closed four-value union (design.md RenderItem→RowKind mapping).
   *
   * Grammar (Req 11.2), colors tokenized except the `error` kind which uses
   * Tailwind palette utilities per the NFR-2 exception:
   *
   * | kind    | align  | bubble                                               | label           |
   * |---------|--------|------------------------------------------------------|-----------------|
   * | agent   | RIGHT  | `--agent-bubble-bg` / `--agent-bubble-text`          | "Agent"         |
   * | prompt  | LEFT   | `--surface` + `--border` border                      | "Prompt"/"You"  |
   * | system  | CENTER | none; muted text with divider lines                  | — (no label)    |
   * | error   | RIGHT  | `bg-red-900/30 border border-red-700 text-red-300`   | "Error"         |
   *
   * Agent text is rendered through `<MessageBubble bare />` (the single
   * sanctioned sanitized-markdown sink); this component contains NO raw-HTML
   * directive of its own (Req 11.7 / NFR-1). All other kinds render as
   * escaped plain text. Agent rows are never centered (Req 11.6).
   *
   * The label line (Req 11.3) appears above the bubble when `showLabel` is true
   * and the kind is not `system`. The entry timestamp is exposed both as the
   * row's `title` attribute and as a displayed relative string.
   */
  import { formatRelativeTime, type RowKind } from '../lib/logic.js';
  import MessageBubble from './MessageBubble.svelte';

  interface Props {
    kind: RowKind;
    /** The row text (agent markdown source; plain text for other kinds). */
    text: string;
    /** Label override; defaults derive from `kind`. Also the grouping key. */
    label?: string;
    /** ISO timestamp; shown in `title` + as a relative string. */
    timestamp?: string;
    /** Hide the label line for grouped consecutive rows (Req 11.4). */
    showLabel?: boolean;
    /** Show the streaming cursor on the agent bubble (Req 7.2). */
    cursor?: boolean;
  }

  const { kind, text, label, timestamp, showLabel = true, cursor = false }: Props = $props();

  const DEFAULT_LABEL: Record<RowKind, string> = {
    agent: 'Agent',
    prompt: 'Prompt',
    system: '',
    error: 'Error',
  };

  const resolvedLabel = $derived(label ?? DEFAULT_LABEL[kind]);

  // Relative time computed at render; the clock is injected to the pure helper.
  // A missing/invalid timestamp yields no relative string.
  const relative = $derived.by(() => {
    if (timestamp === undefined) return '';
    const tsMs = Date.parse(timestamp);
    if (Number.isNaN(tsMs)) return '';
    return formatRelativeTime(Date.now(), tsMs);
  });

  // Column cross-axis alignment: prompt LEFT (items-start), agent + error RIGHT
  // (items-end). System is handled by its own centered branch below.
  const itemsAlign = $derived(kind === 'prompt' ? 'items-start' : 'items-end');

  // Bubble classes per kind (system has no bubble).
  const BUBBLE_CLASS: Record<RowKind, string> = {
    agent: 'rounded-2xl bg-[var(--agent-bubble-bg)] px-3 py-2 text-[var(--agent-bubble-text)]',
    prompt:
      'rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text-primary)]',
    system: '',
    error: 'rounded-2xl border border-red-700 bg-red-900/30 px-3 py-2 text-red-300',
  };

  const showLabelLine = $derived(showLabel && kind !== 'system');
</script>

{#if kind === 'system'}
  <!-- Centered system row: no bubble, muted text with divider lines. -->
  <div
    data-testid="message-row"
    data-kind="system"
    title={timestamp}
    class="flex w-full items-center gap-2 text-xs text-[var(--text-muted)]"
  >
    <span aria-hidden="true" class="h-px flex-1 bg-[var(--border)]"></span>
    <span class="break-words text-center" style="overflow-wrap: anywhere;">{text}</span>
    <span aria-hidden="true" class="h-px flex-1 bg-[var(--border)]"></span>
  </div>
{:else}
  <div
    data-testid="message-row"
    data-kind={kind}
    title={timestamp}
    class="flex w-full flex-col {itemsAlign}"
  >
    {#if showLabelLine}
      <div
        data-testid="message-row-label"
        class="mb-1 flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]"
      >
        <span>{resolvedLabel}</span>
        {#if relative}
          <span data-testid="message-row-time">{relative}</span>
        {/if}
      </div>
    {/if}
    <div
      class="max-w-[85vw] break-words text-sm md:max-w-[70%] {BUBBLE_CLASS[kind]}"
      style="overflow-wrap: anywhere;"
    >
      {#if kind === 'agent'}
        <MessageBubble {text} {cursor} bare />
      {:else}
        <span class="whitespace-pre-wrap">{text}</span>
      {/if}
    </div>
  </div>
{/if}
