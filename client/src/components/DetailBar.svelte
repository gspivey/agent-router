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

  interface Props {
    /** The session title shown between the back and Interrupt controls. */
    title: string;
    /** Called when the operator confirms the interrupt. */
    onInterrupt: () => Promise<void>;
    /** When true the Interrupt control is visible but inert (session ended). */
    disabled?: boolean;
  }

  const { title, onInterrupt, disabled = false }: Props = $props();

  let confirming = $state(false);
  let interrupting = $state(false);

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

{#if confirming}
  <div
    data-testid="interrupt-confirm"
    role="dialog"
    aria-modal="true"
    aria-label="Interrupt confirmation"
    class="fixed inset-0 z-20 flex items-center justify-center bg-black/50 px-4"
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
