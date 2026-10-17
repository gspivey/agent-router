<script lang="ts">
  /**
   * A single Overview stat card (spa-polish ROADMAP 89, Req 12.3).
   *
   * A thin wrapper over `Card` showing a muted label, a prominent value, and an
   * OPTIONAL `StatusBadge` below the value. The badge exists because a stat like
   * Health needs a status pill widget that the scalar `value` alone cannot
   * carry (the Health card passes `value="System"` plus a `badge` derived from
   * the daemon `health` field). All colors reference `app.css` tokens (NFR-2).
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
  }

  const { label, value, badge }: Props = $props();
</script>

<Card>
  <div data-testid="stat-card" data-label={label}>
    <div class="text-xs text-[var(--text-muted)]">{label}</div>
    <div
      data-testid="stat-card-value"
      class="mt-1 text-2xl font-semibold text-[var(--text-primary)]"
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
