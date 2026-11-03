<script lang="ts">
  /**
   * A single Overview stat card (spa-polish ROADMAP 89, Req 12.3).
   *
   * A thin wrapper over `Card` showing a muted label, a prominent value, and an
   * OPTIONAL `StatusBadge` below the value. The badge exists because a stat like
   * Health needs a status pill widget that the scalar `value` alone cannot
   * carry (the Health card passes `value="System"` plus a badge derived from
   * the daemon `health` field). All colors reference `app.css` tokens (NFR-2).
   *
   * The optional `highlight` prop (`'success' | 'danger'`) colors the value text
   * green or red respectively, allowing callers to draw visual attention when a
   * count is non-zero (e.g. red for failed tasks, green for succeeded tasks).
   * See BACKLOG.md § P2.44.
   */
  import Card from './Card.svelte';
  import StatusBadge from './StatusBadge.svelte';

  type BadgeState = 'active' | 'paused' | 'error';

  interface StatBadge {
    state: BadgeState;
    label?: string;
  }

  interface Props {
    label: string;
    value: string | number;
    /** When provided, a `StatusBadge` renders below the value (e.g. Health). */
    badge?: StatBadge;
    /**
     * When `'success'`, the value renders in `var(--success,#16a34a)` (green).
     * When `'danger'`, the value renders in `var(--error,#dc2626)` (red).
     * When absent, the value renders in the default `var(--text-primary)`.
     * See BACKLOG.md § P2.44.
     */
    highlight?: 'success' | 'danger';
  }

  const { label, value, badge, highlight }: Props = $props();

  const valueColor = $derived(
    highlight === 'success'
      ? 'var(--success,#16a34a)'
      : highlight === 'danger'
        ? 'var(--error,#dc2626)'
        : 'var(--text-primary)',
  );
</script>

<Card>
  <div data-testid="stat-card" data-label={label} data-highlight={highlight ?? null}>
    <div class="text-xs text-[var(--text-muted)]">{label}</div>
    <div
      data-testid="stat-card-value"
      class="mt-1 text-2xl font-semibold"
      style="color: {valueColor}"
    >
      {value}
    </div>
    {#if badge}
      <div class="mt-2">
        {#if badge.label !== undefined}
          <StatusBadge state={badge.state} label={badge.label} />
        {:else}
          <StatusBadge state={badge.state} />
        {/if}
      </div>
    {/if}
  </div>
</Card>
