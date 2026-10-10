<script lang="ts">
  /**
   * JSON pivot toggle (spa-overhaul Task 7 / ROADMAP 77).
   *
   * A `{ }` chip that flips a single chat entry between its rendered view and a
   * raw-JSON `<pre>` view (Requirement 8.1, 8.2). The chip is ALWAYS visible on
   * every viewport — on mobile and tablet (below 1024 px) it is a small
   * always-visible chip; on desktop (≥1024 px) the baseline chip stays visible
   * and MAY additionally brighten on hover as an enhancement (never a
   * hover-only reveal). Its tap target is at least 44×44 CSS px (Requirement
   * 8.1 / 8.6).
   *
   * State is owned by the parent `EntryShell` (one toggle per entry); this
   * component is a pure presentational button that reports activation via
   * `onToggle` and reflects the current state through `active` and
   * `aria-pressed`. All colors reference the Requirement 1.7 custom properties —
   * no hardcoded hex (Requirement 8.3).
   */
  interface Props {
    /** True when the entry is currently showing its raw-JSON view. */
    active: boolean;
    /** Toggle the JSON view for this entry. */
    onToggle: () => void;
  }

  const { active, onToggle }: Props = $props();

  // Arbitrary-value Tailwind classes don't work as `class:` directives, so build
  // the class string here. Active = accented chip; inactive = muted chip. All
  // colors reference the Req 1.7 custom properties (no hardcoded hex, Req 8.3).
  const cls = $derived(
    active
      ? 'bg-[var(--tool-card-accent)] text-[var(--agent-bubble-text)]'
      : 'bg-[var(--surface)] text-[var(--text-muted)] opacity-70 hover:opacity-100',
  );
</script>

<button
  type="button"
  data-testid="json-toggle"
  aria-pressed={active}
  aria-label={active ? 'Show rendered view' : 'Show raw JSON'}
  title={active ? 'Show rendered view' : 'Show raw JSON'}
  onclick={onToggle}
  class="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-[var(--border)] font-mono text-xs {cls}"
>
  {'{ }'}
</button>
