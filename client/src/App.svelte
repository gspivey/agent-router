<script lang="ts">
  /**
   * SPA shell (spa-overhaul Task 4 / ROADMAP 74).
   *
   * Resolves the bearer token with the Requirement 3.1 precedence (Task 3),
   * renders the auth-error state when the token is missing or expired, and
   * otherwise mounts the single-destination chrome (`Header`) plus the
   * hash-routed view: the Overview dashboard at `#/`, the session list at
   * `#/sessions`, the chat/detail view at `#/sessions/<id>`, and the operator
   * config at `#/config` (spa-polish ROADMAP 88).
   *
   * The chat view (ROADMAP 75) renders the session history as a chat
   * conversation. The `overview` branch renders a placeholder here (ROADMAP 88);
   * the real `Overview.svelte` lands in ROADMAP 89.
   */
  import { onMount } from 'svelte';
  import { auth } from './lib/stores.svelte.js';
  import { route, startRouter } from './routes/router.svelte.js';
  import Header from './components/Header.svelte';
  import SessionList from './components/SessionList.svelte';
  import ConfigView from './components/ConfigView.svelte';
  import ChatView from './components/ChatView.svelte';
  import PageLayout from './components/PageLayout.svelte';

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
    {#if route.current.view === 'overview'}
      <PageLayout width="wide">
        <div data-testid="overview-placeholder" class="text-sm text-[var(--text-muted)]">
          Loading…
        </div>
      </PageLayout>
    {:else if route.current.view === 'list'}
      <PageLayout width="wide"><SessionList /></PageLayout>
    {:else if route.current.view === 'config'}
      <PageLayout width="wide"><ConfigView /></PageLayout>
    {:else}
      <PageLayout width="narrow"><ChatView sessionId={route.current.sessionId} /></PageLayout>
    {/if}
  </div>
{/if}
