<script lang="ts">
  /**
   * The session list view, grouped by repo
   * (spa-operator-restoration ROADMAP 80, Task A-7).
   *
   * Populated from a SINGLE `GET /repos/sessions` request on mount (FR-2.3 — no
   * reconstruction from the flat `/sessions` endpoint). Each repo renders a
   * collapsible `RepoGroup`. Loading, empty (no repos configured), and error
   * states are rendered inline with the same `data-testid`s as before.
   *
   * Auto-refresh: polls every 30 seconds (BACKLOG.md § P2.49). A "last updated"
   * timestamp is shown below the repo groups; a "Refresh" button allows manual
   * re-fetch on demand. Background refreshes do not clear existing content —
   * only the initial load and manual error-retries show the loading spinner.
   */
  import { onMount, onDestroy } from 'svelte';
  import { api, AuthError } from '../lib/api.js';
  import type { RepoGroup as RepoGroupData } from '../lib/types.js';
  import RepoGroupComponent from './RepoGroup.svelte';
  import PageHeader from './PageHeader.svelte';

  /** Auto-refresh interval in milliseconds (30 seconds). */
  const REFRESH_INTERVAL_MS = 30_000;

  let groups = $state<RepoGroupData[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /** Whether a background refresh (not the initial load) is in flight. */
  let refreshing = $state(false);
  /** Timestamp of the last successful data fetch (BACKLOG.md § P2.49). */
  let lastRefreshed = $state<Date | null>(null);

  async function load(background = false): Promise<void> {
    if (background) {
      // Background refresh: don't clear existing content, just update silently.
      refreshing = true;
    } else {
      loading = true;
    }
    error = null;
    try {
      const res = await api.listRepoSessions();
      groups = res.repos;
      lastRefreshed = new Date();
    } catch (err) {
      // A 401/403 already entered the expired lockout via `api`; surface other
      // failures as a retriable list error without clearing the token.
      if (!(err instanceof AuthError)) {
        // Only show errors on non-background refreshes to avoid flicker.
        if (!background) {
          error = 'Could not load sessions.';
        }
      }
    } finally {
      if (background) {
        refreshing = false;
      } else {
        loading = false;
      }
    }
  }

  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    void load();
    refreshTimer = setInterval(() => void load(true), REFRESH_INTERVAL_MS);
  });

  onDestroy(() => {
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  });

  /** Format a Date as HH:MM:SS for the last-refreshed indicator. */
  function formatTime(d: Date): string {
    return d.toLocaleTimeString();
  }
</script>

<section data-testid="session-list" class="flex flex-col overflow-x-hidden">
  <PageHeader title="Sessions" subtitle="Agent sessions grouped by repository" />
  {#if loading}
    <p data-testid="list-loading" class="p-4 text-sm text-[var(--text-muted)]">Loading sessions…</p>
  {:else if error}
    <div data-testid="list-error" class="flex flex-col items-start gap-3 p-4">
      <p class="m-0 text-sm text-[var(--error)]">{error}</p>
      <button
        type="button"
        data-testid="list-retry"
        onclick={() => void load()}
        class="min-h-[44px] rounded border border-[var(--border)] bg-[var(--surface)] px-4 text-sm text-[var(--text-primary)]"
      >
        Retry
      </button>
    </div>
  {:else if groups.length === 0}
    <div
      data-testid="list-empty"
      class="flex flex-col items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center"
    >
      <span aria-hidden="true" class="text-2xl text-[var(--text-muted)]">📭</span>
      <p class="m-0 text-sm text-[var(--text-muted)]">No sessions yet.</p>
    </div>
  {:else}
    {#each groups as group (group.repo)}
      <RepoGroupComponent {group} />
    {/each}
  {/if}

  <!-- Last-refreshed indicator + manual refresh button (BACKLOG.md § P2.49) -->
  {#if !loading && error === null}
    <div class="flex items-center gap-3 px-4 py-2">
      {#if lastRefreshed !== null}
        <p
          data-testid="sessions-last-refreshed"
          class="m-0 text-xs text-[var(--text-muted)]"
        >
          Last updated {formatTime(lastRefreshed)}
        </p>
      {/if}
      <button
        type="button"
        data-testid="sessions-refresh"
        onclick={() => void load()}
        disabled={refreshing}
        class="min-h-[32px] rounded border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-hover,var(--surface))] disabled:opacity-50"
      >
        Refresh
      </button>
    </div>
  {/if}
</section>
