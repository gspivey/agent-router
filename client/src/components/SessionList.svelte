<script lang="ts">
  /**
   * The session list view, grouped by repo
   * (spa-operator-restoration ROADMAP 80, Task A-7).
   *
   * Populated from a SINGLE `GET /repos/sessions` request on mount (FR-2.3 — no
   * reconstruction from the flat `/sessions` endpoint). Each repo renders a
   * collapsible `RepoGroup`. Loading, empty (no repos configured), and error
   * states are rendered inline with the same `data-testid`s as before.
   */
  import { onMount } from 'svelte';
  import { api, AuthError } from '../lib/api.js';
  import type { RepoGroup as RepoGroupData } from '../lib/types.js';
  import RepoGroupComponent from './RepoGroup.svelte';
  import PageHeader from './PageHeader.svelte';

  let groups = $state<RepoGroupData[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await api.listRepoSessions();
      groups = res.repos;
    } catch (err) {
      // A 401/403 already entered the expired lockout via `api`; surface other
      // failures as a retriable list error without clearing the token.
      if (!(err instanceof AuthError)) {
        error = 'Could not load sessions.';
      }
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });
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
        onclick={load}
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
</section>
