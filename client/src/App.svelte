<script lang="ts">
  /**
   * SPA shell (spa-overhaul Task 4 / ROADMAP 74).
   *
   * Resolves the bearer token with the Requirement 3.1 precedence (Task 3),
   * renders the auth-error state when the token is missing or expired, and
   * otherwise mounts the single-destination chrome (`Header`) plus the
   * hash-routed view: the session list at `#/` and the chat/detail view at
   * `#/sessions/<id>`.
   *
   * The chat view itself lands in a later item (ROADMAP 75); this item renders a
   * lightweight detail placeholder so the list → detail navigation is observable
   * end to end. Navigation has exactly ONE destination — Sessions — and no Repos
   * or Config views exist (Requirement 5.3, 5.8).
   */
  import { onMount } from 'svelte';
  import { auth } from './lib/stores.svelte.js';
  import { route, startRouter, goToList } from './routes/router.svelte.js';
  import Header from './components/Header.svelte';
  import SessionList from './components/SessionList.svelte';

  // The token is resolved in `main.ts` before mount, so children that fetch on
  // their own `onMount` already see it. Here we only wire the hash router.
  onMount(() => {
    const stop = startRouter();
    return stop;
  });

  function reload(): void {
    location.reload();
  }
</script>

{#if auth.error === 'missing'}
  <main class="min-h-screen p-4">
    <section data-testid="auth-error" data-auth-state="missing">
      <p class="text-[var(--error)]">No access token — open the dashboard from a shared link.</p>
    </section>
  </main>
{:else if auth.error === 'expired'}
  <main class="min-h-screen p-4">
    <section data-testid="auth-error" data-auth-state="expired">
      <p class="text-[var(--error)]">Session expired — reload the page</p>
      <button type="button" data-testid="reload-button" onclick={reload}>Reload</button>
    </section>
  </main>
{:else}
  <div data-testid="app-shell" class="min-h-screen">
    <Header />
    {#if route.current.view === 'list'}
      <SessionList />
    {:else}
      <section data-testid="detail-placeholder" data-session-id={route.current.sessionId} class="p-4">
        <button
          type="button"
          data-testid="back-to-list"
          onclick={goToList}
          class="min-h-[44px] rounded border border-[var(--border)] bg-[var(--surface)] px-4 text-sm text-[var(--text-primary)]"
        >
          ← Sessions
        </button>
        <p class="mt-4 text-sm text-[var(--text-muted)]">
          Session {route.current.sessionId}
        </p>
      </section>
    {/if}
  </div>
{/if}
