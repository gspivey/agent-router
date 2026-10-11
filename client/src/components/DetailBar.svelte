<script lang="ts">
  /**
   * Chat detail bottom bar (spa-overhaul Task 6 / ROADMAP 76).
   *
   * On mobile/tablet (below 1024 px) the chat view's bottom bar: a back button,
   * the session title, and the Interrupt control (Requirement 5.3, 7.7). The
   * button is labeled "Interrupt" (NOT "Kill") and interrupts the CURRENT agent
   * turn — it does not necessarily end the session (Requirement 7.7 / HIGH-6).
   *
   * Activating Interrupt opens a tap-confirmable confirmation ("Interrupt the
   * current agent turn?") that is confirmed by TAP alone — no hover is required
   * (Requirement 7.7). On confirm the caller's `onInterrupt` runs; the parent
   * re-fetches `meta` afterward and does NOT assume the session ended. When
   * `disabled` (session ended — Requirement 7.8) the Interrupt button stays
   * visible but inert. Every tap target is ≥44×44 CSS px.
   */
  import { goToList } from '../routes/router.svelte.js';
  import { api } from '../lib/api.js';
  import type { SessionStatus } from '../lib/types.js';
  import KillConfirmDialog from './KillConfirmDialog.svelte';

  interface Props {
    /** The session title shown between the back and Interrupt controls. */
    title: string;
    /** The session id this bar acts on (for the Kill action). */
    sessionId: string;
    /** The session status — the Kill button renders only when `'active'`. */
    status: SessionStatus;
    /** Called when the operator confirms the interrupt. */
    onInterrupt: () => Promise<void>;
    /** When true the Interrupt control is visible but inert (session ended). */
    disabled?: boolean;
  }

  const { title, sessionId, status, onInterrupt, disabled = false }: Props = $props();

  let confirming = $state(false);
  let interrupting = $state(false);

  // Kill action state (spa-operator-restoration B-3 / FR-6).
  let showKillConfirm = $state(false);
  let killing = $state(false);
  let killError = $state<string | null>(null);

  function openConfirm(): void {
    if (disabled || interrupting) return;
    confirming = true;
  }

  function cancel(): void {
    confirming = false;
  }

  async function confirm(): Promise<void> {
    confirming = false;
    interrupting = true;
    try {
      await onInterrupt();
    } finally {
      interrupting = false;
    }
  }

  function openKillConfirm(): void {
    if (killing) return;
    // Clear any prior error on a fresh Kill attempt (FR-6.2e).
    killError = null;
    showKillConfirm = true;
  }

  function cancelKill(): void {
    showKillConfirm = false;
  }

  async function doKill(): Promise<void> {
    showKillConfirm = false;
    killing = true;
    killError = null;
    try {
      await api.kill(sessionId);
      // The SSE stream delivers `session_ended`; no optimistic update (FR-6.2d).
    } catch {
      killError = 'Failed to kill session.';
    } finally {
      killing = false;
    }
  }
</script>

<nav
  data-testid="detail-bar"
  class="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2"
  style="padding-bottom: calc(0.5rem + env(safe-area-inset-bottom));"
>
  <button
    type="button"
    data-testid="detail-back"
    onclick={goToList}
    class="min-h-[44px] min-w-[44px] rounded border border-[var(--border)] px-3 text-sm text-[var(--text-primary)]"
    aria-label="Back to sessions"
  >
    ←
  </button>
  <span class="min-w-0 flex-1 truncate text-sm text-[var(--text-muted)]">{title}</span>
  {#if status === 'active'}
    <button
      type="button"
      data-testid="kill-button"
      onclick={openKillConfirm}
      disabled={killing}
      aria-label="Kill session"
      class="min-h-[44px] min-w-[44px] rounded bg-[var(--error)] px-3 text-sm font-medium text-white disabled:opacity-50"
    >
      Kill
    </button>
  {/if}
  <button
    type="button"
    data-testid="interrupt-button"
    onclick={openConfirm}
    disabled={disabled}
    class="min-h-[44px] min-w-[44px] rounded border border-[var(--error)] px-3 text-sm font-medium text-[var(--error)] disabled:opacity-50"
  >
    Interrupt
  </button>
</nav>

{#if killError}
  <p
    data-testid="kill-error"
    role="alert"
    class="border-t border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs text-[var(--error)]"
  >
    {killError}
  </p>
{/if}

{#if showKillConfirm}
  <KillConfirmDialog onConfirm={doKill} onCancel={cancelKill} />
{/if}

{#if confirming}
  <div
    data-testid="interrupt-confirm"
    role="dialog"
    aria-modal="true"
    aria-label="Interrupt confirmation"
    class="fixed inset-0 z-20 flex items-center justify-center px-4"
    style="background: color-mix(in srgb, var(--bg) 60%, transparent);"
  >
    <div class="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <p class="m-0 mb-4 text-sm text-[var(--text-primary)]">Interrupt the current agent turn?</p>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          data-testid="interrupt-cancel"
          onclick={cancel}
          class="min-h-[44px] rounded border border-[var(--border)] px-4 text-sm text-[var(--text-primary)]"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="interrupt-confirm-button"
          onclick={confirm}
          class="min-h-[44px] rounded bg-[var(--error)] px-4 text-sm font-medium text-[var(--agent-bubble-text)]"
        >
          Interrupt
        </button>
      </div>
    </div>
  </div>
{/if}
