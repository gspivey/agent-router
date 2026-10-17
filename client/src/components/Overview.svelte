<script lang="ts">
  /**
   * Overview dashboard page at `#/` (spa-polish ROADMAP 89, Req 12).
   *
   * Fetches `GET /api/overview` AND the session list on mount via the API layer.
   * Renders a `PageHeader`, a responsive four-card stat row (Active Sessions,
   * Queued Work, Recent PRs in the last 24h, and a Health badge), a Recent
   * Sessions list (last five sessions, reusing `SessionCard`), and a compact
   * Cron Summary table. Each section surfaces a skeleton loading state while the
   * request is in flight (Req 12.6) and a muted icon + message empty state when
   * its data is empty (Req 12.7 / 14.1). A failed `getOverview()` (crashed or
   * unreachable daemon) is surfaced as a client-only "failed to fetch" error
   * state, not a server `health` value (Req 2.2). `AuthError` is swallowed — the
   * global auth lockout handles it. All colors reference `app.css` tokens.
   */
  import { onMount } from 'svelte';
  import { api, AuthError } from '../lib/api.js';
  import type { OverviewResponse, SessionSummary } from '../lib/types.js';
  import Card from './Card.svelte';
  import PageHeader from './PageHeader.svelte';
  import StatCard from './StatCard.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import SessionCard from './SessionCard.svelte';

  /** One day in milliseconds — the "Recent PRs (24h)" window. */
  const DAY_MS = 86_400_000;

  let overview = $state<OverviewResponse | null>(null);
  let recentSessions = $state<SessionSummary[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      // Fetch the overview and the recent-session slice in parallel. The session
      // list reuses the same endpoint `SessionList` reads from.
      const [ov, list] = await Promise.all([
        api.getOverview(),
        api.listSessions({ limit: 5 }),
      ]);
      overview = ov;
      recentSessions = list.sessions.slice(0, 5);
    } catch (err) {
      // A 401/403 already entered the expired lockout via `api`; surface other
      // failures as a client-only error state without clearing the token.
      if (!(err instanceof AuthError)) {
        error = 'Failed to fetch overview.';
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  /** Count of recent PRs opened within the last 24 hours (Req 12.2). */
  const recentPrCount = $derived.by(() => {
    if (overview === null) return 0;
    const cutoff = Date.now() - DAY_MS;
    return overview.recent_prs.filter((pr) => {
      const t = Date.parse(pr.opened_at);
      return Number.isFinite(t) && t >= cutoff;
    }).length;
  });

  /** Health → badge mapping (Req 12.3). There is no `error` health state. */
  const healthBadge = $derived(
    overview === null
      ? ({ state: 'active', label: 'Healthy' } as const)
      : overview.health === 'degraded'
        ? ({ state: 'paused', label: 'Degraded' } as const)
        : ({ state: 'active', label: 'Healthy' } as const),
  );

  /** Format an ISO datetime as a locale string; "—" when null/unparseable. */
  function formatNextFire(isoString: string | null): string {
    if (isoString === null) return '—';
    const d = new Date(isoString);
    return Number.isNaN(d.getTime()) ? isoString : d.toLocaleString();
  }
</script>

<section data-testid="overview" class="flex flex-col gap-6">
  <PageHeader title="Overview" subtitle="Daemon activity and health at a glance" />

  {#if error !== null}
    <div data-testid="overview-error" role="alert" class="flex flex-col items-start gap-3">
      <p class="m-0 text-sm text-[var(--error)]">{error}</p>
      <button
        type="button"
        data-testid="overview-retry"
        onclick={() => void load()}
        class="min-h-[44px] rounded border border-[var(--border)] bg-[var(--surface)] px-4 text-sm text-[var(--text-primary)]"
      >
        Retry
      </button>
    </div>
  {:else}
    <!-- Stat row (Req 12.2, 12.3) -->
    {#if loading}
      <div
        data-testid="stat-row-skeleton"
        class="grid grid-cols-2 gap-4 lg:grid-cols-4"
        aria-hidden="true"
      >
        {#each Array(4) as _unused}
          <div class="h-20 animate-pulse rounded-lg bg-[var(--surface)]"></div>
        {/each}
      </div>
    {:else if overview !== null}
      <div data-testid="stat-row" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Active Sessions" value={overview.active_sessions} />
        <StatCard label="Queued Work" value={overview.queue_depth} />
        <StatCard label="Recent PRs (24h)" value={recentPrCount} />
        <StatCard label="Health" value="System" badge={healthBadge} />
      </div>
    {/if}

    <!-- Recent Sessions (Req 12.4) -->
    <section data-testid="recent-sessions">
      <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Recent Sessions</h2>
      {#if loading}
        <div data-testid="recent-sessions-skeleton" aria-hidden="true" class="flex flex-col gap-2">
          {#each Array(3) as _unused}
            <div class="h-16 animate-pulse rounded-lg bg-[var(--surface)]"></div>
          {/each}
        </div>
      {:else if recentSessions.length === 0}
        <div
          data-testid="recent-sessions-empty"
          class="flex flex-col items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center"
        >
          <span aria-hidden="true" class="text-2xl text-[var(--text-muted)]">💤</span>
          <p class="m-0 text-sm text-[var(--text-muted)]">No recent sessions.</p>
        </div>
      {:else}
        <div class="overflow-x-hidden rounded-lg border border-[var(--border)]">
          {#each recentSessions as session (session.session_id)}
            <SessionCard {session} />
          {/each}
        </div>
      {/if}
    </section>

    <!-- Cron Summary (Req 12.5) -->
    <section data-testid="cron-summary">
      <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Cron Summary</h2>
      {#if loading}
        <div data-testid="cron-summary-skeleton" aria-hidden="true" class="flex flex-col gap-2">
          {#each Array(2) as _unused}
            <div class="h-10 animate-pulse rounded-lg bg-[var(--surface)]"></div>
          {/each}
        </div>
      {:else if overview !== null && overview.cron_summary.length === 0}
        <div
          data-testid="cron-summary-empty"
          class="flex flex-col items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center"
        >
          <span aria-hidden="true" class="text-2xl text-[var(--text-muted)]">🕒</span>
          <p class="m-0 text-sm text-[var(--text-muted)]">No cron schedules configured.</p>
        </div>
      {:else if overview !== null}
        <Card>
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-left text-sm">
              <thead>
                <tr class="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th class="px-2 py-2 font-medium">Name</th>
                  <th class="px-2 py-2 font-medium">Schedule</th>
                  <th class="px-2 py-2 font-medium">Status</th>
                  <th class="px-2 py-2 font-medium">Next Fire</th>
                </tr>
              </thead>
              <tbody>
                {#each overview.cron_summary as cron (cron.name)}
                  <tr
                    data-testid="cron-summary-row"
                    class="border-b border-[var(--border)] last:border-b-0"
                  >
                    <td class="px-2 py-2 text-[var(--text-primary)]">{cron.name}</td>
                    <td class="px-2 py-2 font-mono text-xs text-[var(--text-primary)]">
                      {cron.schedule}
                    </td>
                    <td class="px-2 py-2">
                      <StatusBadge state={cron.state} />
                    </td>
                    <td class="px-2 py-2 text-[var(--text-muted)]">
                      {formatNextFire(cron.next_fire)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Card>
      {/if}
    </section>
  {/if}
</section>
