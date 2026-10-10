<script lang="ts">
  /**
   * Minimal SPA shell for the auth flow (spa-overhaul Task 3 / ROADMAP 73).
   *
   * This item delivers the auth/API/SSE client library plus the auth bootstrap:
   * resolve the token with the Requirement 3.1 precedence, render the auth-error
   * state when the token is missing or expired, and issue one authenticated
   * `GET /sessions` probe so the bearer-header and stored-token flows are
   * observable. The full session-list and chat views land in later items
   * (74–78).
   */
  import { onMount } from 'svelte';
  import { auth, resolveToken } from './lib/stores.svelte.js';
  import { api, AuthError } from './lib/api.js';

  const title = 'Agent Router';
  let probe = $state<'idle' | 'loading' | 'ok' | 'error'>('idle');
  let sessionCount = $state<number | null>(null);

  onMount(() => {
    resolveToken();
    if (auth.token !== null) {
      void runProbe();
    }
  });

  async function runProbe(): Promise<void> {
    probe = 'loading';
    try {
      const res = await api.listSessions();
      sessionCount = res.total;
      probe = 'ok';
    } catch (err) {
      // A 401/403 already set auth.error = 'expired' via the lockout; other
      // failures surface as a generic error without clearing the token.
      probe = 'error';
      if (!(err instanceof AuthError)) {
        // Non-auth error — leave the token intact.
      }
    }
  }

  function reload(): void {
    location.reload();
  }
</script>

<main class="min-h-screen p-4">
  <h1 class="text-[var(--text-primary)]">{title}</h1>

  {#if auth.error === 'missing'}
    <section data-testid="auth-error" data-auth-state="missing">
      <p class="text-[var(--error)]">No access token — open the dashboard from a shared link.</p>
    </section>
  {:else if auth.error === 'expired'}
    <section data-testid="auth-error" data-auth-state="expired">
      <p class="text-[var(--error)]">Session expired — reload the page</p>
      <button type="button" data-testid="reload-button" onclick={reload}>Reload</button>
    </section>
  {:else}
    <section data-testid="authed" data-probe={probe}>
      <p class="text-[var(--text-muted)]">
        {#if probe === 'ok'}
          Authenticated — {sessionCount} session(s).
        {:else if probe === 'loading'}
          Loading sessions…
        {:else if probe === 'error'}
          Request failed.
        {:else}
          Dashboard SPA — auth online.
        {/if}
      </p>
    </section>
  {/if}
</main>
