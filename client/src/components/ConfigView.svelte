<script lang="ts">
  /**
   * Operator Config view (spa-operator-restoration ROADMAP 82, Task C-2).
   *
   * Fetches `GET /config` on mount and renders five sections:
   *   - Token Health (table, colored status dots, red-row highlight) — FR-7.2.
   *   - Cron Schedules (table, inline optimistic pause/resume toggle) — FR-7.3.
   *   - Session Timeouts (display-only card) — FR-7.4.
   *   - Rate Limits (display-only card) — FR-7.5.
   *   - Repositories (table, webhook-configured indicator, no secrets) — FR-7.6.
   *
   * Tables are wrapped in `overflow-x-auto` containers so they stay readable on
   * mobile without breaking the table structure (FR-7.7). Cron pause/resume
   * state is held in `SvelteMap` instances — a plain `Map` is not reactive in
   * Svelte 5, so `.set()` would not trigger a re-render.
   */
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { api, AuthError } from '../lib/api.js';
  import type { ConfigResponse } from '../lib/types.js';

  /** Exact backend sentinel string for a configured per-repo webhook secret. */
  const WEBHOOK_CONFIGURED = '[configured]';

  let config = $state<ConfigResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /** Optimistic paused state keyed by cron name (FR-7.3). */
  const cronPaused = new SvelteMap<string, boolean>();
  /** Per-row toggle error keyed by cron name (FR-7.3d). */
  const cronErrors = new SvelteMap<string, string>();

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await api.getConfig();
      config = res;
      cronPaused.clear();
      cronErrors.clear();
      for (const c of res.crons) {
        cronPaused.set(c.name, c.paused);
      }
    } catch (err) {
      if (!(err instanceof AuthError)) {
        error = 'Could not load configuration.';
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  /** Pause or resume a cron with an optimistic toggle, reverting on error. */
  async function toggleCron(name: string): Promise<void> {
    const wasPaused = cronPaused.get(name) ?? false;
    cronPaused.set(name, !wasPaused);
    cronErrors.delete(name);
    try {
      if (wasPaused) {
        await api.resumeCron(name);
      } else {
        await api.pauseCron(name);
      }
    } catch (err) {
      cronPaused.set(name, wasPaused);
      if (!(err instanceof AuthError)) {
        cronErrors.set(name, 'Failed to toggle.');
      }
    }
  }

  /** Format an ISO date string as a locale date; empty string on parse error. */
  function formatExpiry(isoString: string): string {
    const d = new Date(isoString);
    return Number.isNaN(d.getTime()) ? isoString : d.toLocaleDateString();
  }

  /** Format an ISO datetime string as a locale datetime; "—" when null. */
  function formatNextFire(isoString: string | null): string {
    if (isoString === null) return '—';
    const d = new Date(isoString);
    return Number.isNaN(d.getTime()) ? isoString : d.toLocaleString();
  }
</script>

<section data-testid="config-view" class="flex flex-col gap-6 p-4">
  {#if loading}
    <p data-testid="config-loading" class="text-sm text-[var(--text-muted)]">Loading…</p>
  {:else if error !== null}
    <div data-testid="config-error" role="alert" class="flex flex-col items-start gap-2">
      <p class="text-sm text-[var(--error)]">{error}</p>
      <button
        type="button"
        data-testid="config-retry"
        class="min-h-[44px] rounded border border-[var(--border)] bg-[var(--surface)] px-4 text-sm text-[var(--text-primary)]"
        onclick={() => void load()}
      >
        Retry
      </button>
    </div>
  {:else if config !== null}
    <!-- Token Health (FR-7.2) -->
    <section>
      <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Token Health</h2>
      <div class="overflow-x-auto rounded border border-[var(--border)]">
        <table class="w-full border-collapse text-left text-sm">
          <thead>
            <tr class="border-b border-[var(--border)] text-[var(--text-muted)]">
              <th class="px-3 py-2 font-medium">Project</th>
              <th class="px-3 py-2 font-medium">Token Name</th>
              <th class="px-3 py-2 font-medium">Status</th>
              <th class="px-3 py-2 font-medium">Expiry</th>
            </tr>
          </thead>
          <tbody>
            {#each config.tokens as token (`${token.project}/${token.tokenName}`)}
              <tr
                data-testid="token-row"
                class="border-b border-[var(--border)] last:border-b-0 {token.health === 'red'
                  ? 'bg-[rgba(248,81,73,0.1)]'
                  : ''}"
              >
                <td class="px-3 py-2 text-[var(--text-primary)]">{token.project}</td>
                <td class="px-3 py-2 font-mono text-xs text-[var(--text-primary)]">{token.tokenName}</td>
                <td class="px-3 py-2">
                  <span
                    data-testid="health-dot"
                    aria-label={token.health}
                    title={token.health}
                    class="inline-block h-2.5 w-2.5 rounded-full {token.health === 'green'
                      ? 'bg-[var(--success)]'
                      : token.health === 'red'
                        ? 'bg-[var(--error)]'
                        : 'bg-[var(--text-muted)]'}"
                  ></span>
                </td>
                <td class="px-3 py-2 text-[var(--text-muted)]">
                  {token.expiry !== null ? formatExpiry(token.expiry) : '—'}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <!-- Cron Schedules (FR-7.3) -->
    <section>
      <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Cron Schedules</h2>
      <div class="overflow-x-auto rounded border border-[var(--border)]">
        <table class="w-full border-collapse text-left text-sm">
          <thead>
            <tr class="border-b border-[var(--border)] text-[var(--text-muted)]">
              <th class="px-3 py-2 font-medium">Name</th>
              <th class="px-3 py-2 font-medium">Repo</th>
              <th class="px-3 py-2 font-medium">Schedule</th>
              <th class="px-3 py-2 font-medium">Next Fire</th>
              <th class="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each config.crons as cron (cron.name)}
              {@const paused = cronPaused.get(cron.name) ?? cron.paused}
              <tr data-testid="cron-row" class="border-b border-[var(--border)] last:border-b-0">
                <td class="px-3 py-2 text-[var(--text-primary)]">{cron.name}</td>
                <td class="px-3 py-2 text-[var(--text-muted)]">{cron.repo}</td>
                <td class="px-3 py-2 font-mono text-xs text-[var(--text-primary)]">{cron.schedule}</td>
                <td class="px-3 py-2 text-[var(--text-muted)]">{formatNextFire(cron.nextFireTime)}</td>
                <td class="px-3 py-2">
                  <button
                    type="button"
                    data-testid="cron-toggle-{cron.name}"
                    aria-label="{paused ? 'Resume' : 'Pause'} cron {cron.name}"
                    class="min-h-[44px] rounded border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text-primary)]"
                    onclick={() => void toggleCron(cron.name)}
                  >
                    {paused ? 'Resume' : 'Pause'}
                  </button>
                  {#if cronErrors.has(cron.name)}
                    <p
                      data-testid="cron-error-{cron.name}"
                      role="alert"
                      class="mt-1 text-xs text-[var(--error)]"
                    >
                      {cronErrors.get(cron.name)}
                    </p>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <!-- Session Timeouts (FR-7.4) -->
    <section>
      <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Session Timeouts</h2>
      <dl
        data-testid="session-timeouts"
        class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-sm"
      >
        <dt class="text-[var(--text-muted)]">Inactivity timeout</dt>
        <dd class="text-[var(--text-primary)]">{config.sessionTimeouts.inactivityMinutes} min</dd>
        <dt class="text-[var(--text-muted)]">Max lifetime</dt>
        <dd class="text-[var(--text-primary)]">{config.sessionTimeouts.maxLifetimeMinutes} min</dd>
        <dt class="text-[var(--text-muted)]">Grace period after merge</dt>
        <dd class="text-[var(--text-primary)]">{config.sessionTimeouts.gracePeriodAfterMergeSeconds} s</dd>
      </dl>
    </section>

    <!-- Rate Limits (FR-7.5) -->
    <section>
      <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Rate Limits</h2>
      <dl
        data-testid="rate-limits"
        class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-sm"
      >
        <dt class="text-[var(--text-muted)]">Per-PR interval</dt>
        <dd class="text-[var(--text-primary)]">{config.rateLimits.perPRSeconds} s</dd>
      </dl>
    </section>

    <!-- Repositories (FR-7.6) -->
    <section>
      <h2 class="mb-2 text-sm font-semibold text-[var(--text-primary)]">Repositories</h2>
      <div class="overflow-x-auto rounded border border-[var(--border)]">
        <table class="w-full border-collapse text-left text-sm">
          <thead>
            <tr class="border-b border-[var(--border)] text-[var(--text-muted)]">
              <th class="px-3 py-2 font-medium">Owner/Repo</th>
              <th class="px-3 py-2 font-medium">Webhook Configured</th>
            </tr>
          </thead>
          <tbody>
            {#each config.repos as repo (repo.name)}
              {@const configured = repo.webhookSecretName === WEBHOOK_CONFIGURED}
              <tr data-testid="repo-row" class="border-b border-[var(--border)] last:border-b-0">
                <td class="px-3 py-2 font-mono text-xs text-[var(--text-primary)]">{repo.name}</td>
                <td class="px-3 py-2">
                  <span
                    data-testid="webhook-indicator"
                    class="inline-flex items-center gap-1 text-xs {configured
                      ? 'text-[var(--success)]'
                      : 'text-[var(--warning)]'}"
                  >
                    <span
                      aria-hidden="true"
                      class="inline-block h-2 w-2 rounded-full {configured
                        ? 'bg-[var(--success)]'
                        : 'bg-[var(--warning)]'}"
                    ></span>
                    {configured ? 'yes' : 'no'}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
</section>
