<script lang="ts">
  /**
   * Overview dashboard page at `#/` (spa-polish ROADMAP 89, Req 12).
   *
   * Fetches `GET /api/overview` AND the session list on mount via the API layer.
   * Renders a `PageHeader`, a responsive stat row (Active Sessions, Queued Work,
   * Pending Wakes, Recent PRs in the last 24h, and a Health badge), a Recent
   * Sessions list (last five sessions, reusing `SessionCard`), and a compact
   * Cron Summary table. Each section surfaces a skeleton loading state while the
   * request is in flight (Req 12.6) and a muted icon + message empty state when
   * its data is empty (Req 12.7 / 14.1). A failed `getOverview()` (crashed or
   * unreachable daemon) is surfaced as a client-only "failed to fetch" error
   * state, not a server `health` value (Req 2.2). `AuthError` is swallowed — the
   * global auth lockout handles it. All colors reference `app.css` tokens.
   *
   * Auto-refresh: polls every 30 seconds (BACKLOG.md § P2.34). A "last updated"
   * timestamp is shown below the stat row; a "Refresh" button allows manual
   * re-fetch on demand.
   */
  import { onMount, onDestroy } from 'svelte';
  import { api, AuthError } from '../lib/api.js';
  import type { OverviewResponse, SessionSummary } from '../lib/types.js';
  import { formatUptime } from '../lib/uptime.js';
  import Card from './Card.svelte';
  import PageHeader from './PageHeader.svelte';
  import StatCard from './StatCard.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import SessionCard from './SessionCard.svelte';

  /** Auto-refresh interval in milliseconds (30 seconds). */
  const REFRESH_INTERVAL_MS = 30_000;

  /** One day in milliseconds — the "Recent PRs (24h)" window. */
  const DAY_MS = 86_400_000;

  let overview = $state<OverviewResponse | null>(null);
  let recentSessions = $state<SessionSummary[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /** Timestamp of the last successful data fetch (BACKLOG.md § P2.34). */
  let lastRefreshed = $state<Date | null>(null);

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
      lastRefreshed = new Date();
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

  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    void load();
    refreshTimer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
  });

  onDestroy(() => {
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
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

  /** Format a Date as HH:MM:SS for the last-refreshed indicator. */
  function formatTime(d: Date): string {
    return d.toLocaleTimeString();
  }
</script>

<section data-testid="overview" class="flex flex-col gap-6">
  <PageHeader title="Overview" subtitle={overview !== null ? `Daemon activity and health at a glance — v${overview.version}` : 'Daemon activity and health at a glance'} />

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
    <!-- Restart-required banner (BACKLOG.md § P2.30) -->
    {#if overview !== null && overview.restart_required !== undefined}
      <div
        data-testid="restart-required-banner"
        role="alert"
        class="flex flex-col gap-1 rounded-lg border border-[var(--warning,#b45309)] bg-[var(--warning-bg,#fffbeb)] p-3 text-sm"
      >
        <p class="m-0 font-semibold text-[var(--warning-text,#92400e)]">
          ⚠ Restart required
        </p>
        <p class="m-0 text-[var(--warning-text,#92400e)]">
          The following config fields changed and require a daemon restart to take effect:
          <strong>{overview.restart_required.fields.join(', ')}</strong>.
          Detected at {new Date(overview.restart_required.since).toLocaleString()}.
        </p>
      </div>
    {/if}

    <!-- Token expiry banner (BACKLOG.md § P2.33) -->
    {#if overview !== null && overview.token_expiry !== undefined}
      {@const te = overview.token_expiry}
      <div
        data-testid="token-expiry-banner"
        role="alert"
        class={[
          'flex flex-col gap-1 rounded-lg border p-3 text-sm',
          te.severity === 'error'
            ? 'border-[var(--error,#b91c1c)] bg-[var(--error-bg,#fef2f2)]'
            : 'border-[var(--warning,#b45309)] bg-[var(--warning-bg,#fffbeb)]',
        ].join(' ')}
      >
        <p
          class={[
            'm-0 font-semibold',
            te.severity === 'error'
              ? 'text-[var(--error-text,#7f1d1d)]'
              : 'text-[var(--warning-text,#92400e)]',
          ].join(' ')}
        >
          {te.severity === 'error' ? '🔴' : '⚠'} GitHub token expiring soon
        </p>
        <p
          class={[
            'm-0',
            te.severity === 'error'
              ? 'text-[var(--error-text,#7f1d1d)]'
              : 'text-[var(--warning-text,#92400e)]',
          ].join(' ')}
        >
          {te.days_remaining <= 0
            ? `Token expired ${Math.abs(te.days_remaining)} day${Math.abs(te.days_remaining) === 1 ? '' : 's'} ago`
            : `Token expires in ${te.days_remaining} day${te.days_remaining === 1 ? '' : 's'}`}
          ({new Date(te.expires_at).toLocaleDateString()}).
          Rotate the PAT and update <code>tokenExpiresAt</code> in config.
        </p>
      </div>
    {/if}

    <!-- Stat row (Req 12.2, 12.3) -->
    {#if loading}
      <div
        data-testid="stat-row-skeleton"
        class="grid grid-cols-2 gap-4 lg:grid-cols-9"
        aria-hidden="true"
      >
        {#each Array(9) as _unused}
          <div class="h-20 animate-pulse rounded-lg bg-[var(--surface)]"></div>
        {/each}
      </div>
    {:else if overview !== null}
      <div data-testid="stat-row" class="grid grid-cols-2 gap-4 lg:grid-cols-9">
        <StatCard label="Active Sessions" value={overview.active_sessions} />
        <StatCard label="Queued Work" value={overview.queue_depth} />
        <StatCard label="Pending Wakes" value={overview.pending_wakes_count} />
        <StatCard label="Events (24h)" value={overview.events_processed_24h} />
        {#if overview.tasks_succeeded_24h > 0}
          <StatCard label="Tasks Done (24h)" value={overview.tasks_succeeded_24h} highlight="success" />
        {:else}
          <StatCard label="Tasks Done (24h)" value={overview.tasks_succeeded_24h} />
        {/if}
        {#if overview.tasks_failed_24h > 0}
          <StatCard label="Tasks Failed (24h)" value={overview.tasks_failed_24h} highlight="danger" />
        {:else}
          <StatCard label="Tasks Failed (24h)" value={overview.tasks_failed_24h} />
        {/if}
        <StatCard label="Recent PRs (24h)" value={recentPrCount} />
        <StatCard label="Health" value="System" badge={healthBadge} />
        <StatCard label="Uptime" value={formatUptime(overview.uptime_s)} />
      </div>
      <!-- Last-refreshed indicator + manual refresh button (BACKLOG.md § P2.34) -->
      <div class="flex items-center gap-3">
        {#if lastRefreshed !== null}
          <p
            data-testid="last-refreshed"
            class="m-0 text-xs text-[var(--text-muted)]"
          >
            Last updated {formatTime(lastRefreshed)}
          </p>
        {/if}
        <button
          type="button"
          data-testid="overview-refresh"
          onclick={() => void load()}
          class="min-h-[32px] rounded border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-hover,var(--surface))]"
        >
          Refresh
        </button>
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
                  <th class="px-2 py-2 font-medium">Last Fired</th>
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
                    <td class="px-2 py-2 text-[var(--text-muted)]" data-testid="cron-last-fired">
                      {cron.last_fired_at !== null ? formatNextFire(cron.last_fired_at) : 'Never'}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Card>
      {/if}
    </section>

    <!-- Continuous Runs (BACKLOG.md § P2.35) — only shown when continuous mode is configured -->
    {#if overview !== null && overview.continuous_runs !== undefined && overview.continuous_runs.length > 0}
      <section data-testid="continuous-runs">
        <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Continuous Runs</h2>
        <Card>
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-left text-sm">
              <thead>
                <tr class="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th class="px-2 py-2 font-medium">Repo</th>
                  <th class="px-2 py-2 font-medium">Status</th>
                  <th class="px-2 py-2 font-medium">Items</th>
                  <th class="px-2 py-2 font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {#each overview.continuous_runs as run (run.repo)}
                  <tr
                    data-testid="continuous-run-row"
                    class="border-b border-[var(--border)] last:border-b-0"
                  >
                    <td class="px-2 py-2 font-mono text-xs text-[var(--text-primary)]">{run.repo}</td>
                    <td class="px-2 py-2">
                      <StatusBadge
                        state={run.status === 'running' ? 'active' : 'paused'}
                        label={run.status === 'running' ? 'Running' : (run.stop_reason ?? 'Stopped')}
                      />
                    </td>
                    <td class="px-2 py-2 text-[var(--text-muted)]">{run.items_completed}</td>
                    <td class="px-2 py-2 text-[var(--text-muted)]">
                      {new Date(run.started_at * 1000).toLocaleString()}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    {/if}

    <!-- Activity by Repo (BACKLOG.md § P2.45) — only shown when at least one repo has sessions -->
    {#if overview !== null && overview.active_sessions_by_repo.length > 0}
      <section data-testid="sessions-by-repo">
        <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Activity by Repo</h2>
        <Card>
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-left text-sm">
              <thead>
                <tr class="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th class="px-2 py-2 font-medium">Repo</th>
                  <th class="px-2 py-2 font-medium text-right">Active</th>
                  <th class="px-2 py-2 font-medium text-right">Done (24h)</th>
                  <th class="px-2 py-2 font-medium">Last Started</th>
                </tr>
              </thead>
              <tbody>
                {#each overview.active_sessions_by_repo as row (row.repo)}
                  <tr
                    data-testid="sessions-by-repo-row"
                    class="border-b border-[var(--border)] last:border-b-0"
                  >
                    <td class="px-2 py-2 font-mono text-xs text-[var(--text-primary)]">{row.repo}</td>
                    <td class="px-2 py-2 text-right">
                      {#if row.active > 0}
                        <span class="font-semibold text-[var(--success,#16a34a)]">{row.active}</span>
                      {:else}
                        <span class="text-[var(--text-muted)]">0</span>
                      {/if}
                    </td>
                    <td class="px-2 py-2 text-right text-[var(--text-muted)]">{row.completed_24h}</td>
                    <td class="px-2 py-2 text-xs text-[var(--text-muted)]" data-testid="last-started-at">
                      {row.last_started_at !== null ? new Date(row.last_started_at * 1000).toLocaleString() : '—'}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    {/if}

    <!-- Recent Events (BACKLOG.md § P2.47) — only shown when at least one event has been processed -->
    {#if overview !== null && overview.recent_events.length > 0}
      <section data-testid="recent-events">
        <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Recent Events</h2>
        <Card>
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-left text-sm">
              <thead>
                <tr class="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th class="px-2 py-2 font-medium">Event</th>
                  <th class="px-2 py-2 font-medium">Repo</th>
                  <th class="px-2 py-2 font-medium">PR</th>
                  <th class="px-2 py-2 font-medium">Wake</th>
                  <th class="px-2 py-2 font-medium">Received</th>
                </tr>
              </thead>
              <tbody>
                {#each overview.recent_events as ev (ev.received_at + ':' + ev.event_type + ':' + (ev.pr_number ?? 'null'))}
                  <tr
                    data-testid="recent-events-row"
                    class="border-b border-[var(--border)] last:border-b-0"
                  >
                    <td class="px-2 py-2 font-mono text-xs text-[var(--text-primary)]">{ev.event_type}</td>
                    <td class="px-2 py-2 font-mono text-xs text-[var(--text-muted)]">{ev.repo}</td>
                    <td class="px-2 py-2 text-[var(--text-muted)]">
                      {ev.pr_number !== null ? `#${ev.pr_number}` : '—'}
                    </td>
                    <td class="px-2 py-2">
                      {#if ev.wake_triggered}
                        <span class="text-xs font-medium text-[var(--success,#16a34a)]">Woke</span>
                      {:else}
                        <span class="text-xs text-[var(--text-muted)]">No wake</span>
                      {/if}
                    </td>
                    <td class="px-2 py-2 text-xs text-[var(--text-muted)]">
                      {new Date(ev.received_at * 1000).toLocaleTimeString()}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    {/if}

    <!-- Queued Tasks (BACKLOG.md § P2.60) — only shown when at least one task is queued -->
    {#if overview !== null && overview.queued_tasks.length > 0}
      <section data-testid="queued-tasks">
        <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Queued Tasks</h2>
        <Card>
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-left text-sm">
              <thead>
                <tr class="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th class="px-2 py-2 font-medium">ID</th>
                  <th class="px-2 py-2 font-medium">Repo</th>
                  <th class="px-2 py-2 font-medium">Title</th>
                  <th class="px-2 py-2 font-medium">Queued</th>
                </tr>
              </thead>
              <tbody>
                {#each overview.queued_tasks as task (task.id_prefix)}
                  <tr
                    data-testid="queued-tasks-row"
                    class="border-b border-[var(--border)] last:border-b-0"
                  >
                    <td class="px-2 py-2 font-mono text-xs text-[var(--text-muted)]">{task.id_prefix}</td>
                    <td class="px-2 py-2 font-mono text-xs text-[var(--text-muted)]">{task.repo}</td>
                    <td class="px-2 py-2 text-[var(--text-primary)] truncate max-w-xs">{task.title}</td>
                    <td class="px-2 py-2 text-xs text-[var(--text-muted)]">
                      {new Date(task.created_at * 1000).toLocaleString()}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    {/if}

    <!-- Recent PRs (BACKLOG.md § P2.54) — only shown when at least one PR is registered -->
    {#if overview !== null && overview.recent_prs.length > 0}
      <section data-testid="recent-prs">
        <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Recent PRs</h2>
        <Card>
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-left text-sm">
              <thead>
                <tr class="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th class="px-2 py-2 font-medium">Title</th>
                  <th class="px-2 py-2 font-medium">Repo</th>
                  <th class="px-2 py-2 font-medium">State</th>
                  <th class="px-2 py-2 font-medium">Opened</th>
                </tr>
              </thead>
              <tbody>
                {#each overview.recent_prs as pr (pr.title + ':' + pr.url + ':' + pr.opened_at)}
                  <tr
                    data-testid="recent-prs-row"
                    class="border-b border-[var(--border)] last:border-b-0"
                  >
                    <td class="px-2 py-2 text-[var(--text-primary)]">
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="underline hover:text-[var(--text-muted)]"
                      >{pr.title}</a>
                    </td>
                    <td class="px-2 py-2 font-mono text-xs text-[var(--text-muted)]">{pr.repo}</td>
                    <td class="px-2 py-2">
                      {#if pr.state === 'open'}
                        <StatusBadge state="active" label="Open" />
                      {:else if pr.state === 'merged'}
                        <StatusBadge state="paused" label="Merged" />
                      {:else}
                        <span class="text-xs text-[var(--text-muted)]">{pr.state}</span>
                      {/if}
                    </td>
                    <td class="px-2 py-2 text-xs text-[var(--text-muted)]">
                      {formatNextFire(pr.opened_at)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    {/if}
  {/if}
</section>
