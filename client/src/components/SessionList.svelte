<script lang="ts">
  /**
   * The session list view (spa-overhaul Task 4 / ROADMAP 74).
   *
   * Populated from a SINGLE `GET /sessions` request on mount (NFR-1.2 — no
   * per-row fan-out), stored in the shared `sessionList` runes store. Each row
   * is a `SessionCard`. Loading, empty, and error states are rendered inline.
   */
  import { onMount } from 'svelte';
  import { api, AuthError } from '../lib/api.js';
  import { sessionList } from '../lib/stores.svelte.js';
  import SessionCard from './SessionCard.svelte';

  async function load(): Promise<void> {
    sessionList.loading = true;
    sessionList.error = null;
    try {
      const res = await api.listSessions();
      sessionList.items = res.sessions;
      sessionList.total = res.total;
    } catch (err) {
      // A 401/403 already entered the expired lockout via `api`; surface other
      // failures as a retriable list error without clearing the token.
      if (!(err instanceof AuthError)) {
        sessionList.error = 'Could not load sessions.';
      }
    } finally {
      sessionList.loading = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<section data-testid="session-list" class="flex flex-col">
  {#if sessionList.loading}
    <p data-testid="list-loading" class="p-4 text-sm text-[var(--text-muted)]">Loading sessions…</p>
  {:else if sessionList.error}
    <div data-testid="list-error" class="flex flex-col items-start gap-3 p-4">
      <p class="m-0 text-sm text-[var(--error)]">{sessionList.error}</p>
      <button
        type="button"
        data-testid="list-retry"
        onclick={load}
        class="min-h-[44px] rounded border border-[var(--border)] bg-[var(--surface)] px-4 text-sm text-[var(--text-primary)]"
      >
        Retry
      </button>
    </div>
  {:else if sessionList.items.length === 0}
    <p data-testid="list-empty" class="p-4 text-sm text-[var(--text-muted)]">No sessions yet.</p>
  {:else}
    {#each sessionList.items as session (session.session_id)}
      <SessionCard {session} />
    {/each}
  {/if}
</section>
