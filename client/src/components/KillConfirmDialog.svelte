<script lang="ts">
  /**
   * Kill-session confirmation dialog (spa-operator-restoration Task B-2 /
   * ROADMAP 81).
   *
   * A modal that confirms the irreversible "Kill" action before the detail bar
   * issues `POST /sessions/:id/kill` (FR-6.2). Confirmed by TAP alone — the two
   * buttons are `"Kill"` (confirm) and `"Cancel"` (dismiss). On mount the
   * `"Cancel"` button is focused (default-safe); `Escape` dismisses; Tab /
   * Shift-Tab cycle within the dialog so focus never escapes while open (NFR-5).
   */
  import { onMount } from 'svelte';

  interface Props {
    /** Called when the operator confirms the kill. */
    onConfirm: () => void;
    /** Called when the operator dismisses the dialog (Cancel / Escape). */
    onCancel: () => void;
  }

  const { onConfirm, onCancel }: Props = $props();

  let cancelBtn = $state<HTMLButtonElement | null>(null);
  let confirmBtn = $state<HTMLButtonElement | null>(null);

  onMount(() => {
    // Default-safe: focus the Cancel button when the dialog opens (NFR-5).
    cancelBtn?.focus();
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    // Trap focus between the two buttons (NFR-5).
    const first = confirmBtn;
    const last = cancelBtn;
    if (first === null || last === null) return;
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<div
  data-testid="kill-confirm-dialog"
  role="dialog"
  tabindex="-1"
  aria-modal="true"
  aria-labelledby="kill-confirm-title"
  onkeydown={onKeydown}
  class="fixed inset-0 z-[100] flex items-center justify-center px-4"
  style="background: color-mix(in srgb, var(--bg) 60%, transparent);"
>
  <div class="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
    <p id="kill-confirm-title" class="m-0 mb-4 text-sm text-[var(--text-primary)]">
      Kill this session? This will terminate the agent process immediately and cannot be undone.
    </p>
    <div class="flex justify-end gap-2">
      <button
        type="button"
        data-testid="kill-cancel"
        bind:this={cancelBtn}
        onclick={onCancel}
        class="min-h-[44px] rounded border border-[var(--border)] px-4 text-sm text-[var(--text-primary)]"
      >
        Cancel
      </button>
      <button
        type="button"
        data-testid="kill-confirm"
        bind:this={confirmBtn}
        onclick={onConfirm}
        class="min-h-[44px] rounded bg-[var(--error)] px-4 text-sm font-medium text-white"
      >
        Kill
      </button>
    </div>
  </div>
</div>
