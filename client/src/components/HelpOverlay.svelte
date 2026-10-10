<script lang="ts">
  /**
   * Keyboard-shortcut help overlay (spa-overhaul Task 7 / ROADMAP 77).
   *
   * Shown when the operator presses `?` on a desktop viewport (≥1024 px,
   * Requirement 8.5). It lists the keyboard shortcuts and dismisses on `Escape`,
   * on a close-button activation, or on a backdrop click. All colors reference
   * the Requirement 1.7 custom properties — no hardcoded hex (Requirement 8.3).
   */
  interface Props {
    /** Close the overlay. */
    onClose: () => void;
  }

  const { onClose }: Props = $props();

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  data-testid="help-overlay"
  role="dialog"
  aria-modal="true"
  aria-label="Keyboard shortcuts"
  class="fixed inset-0 z-50 flex items-center justify-center p-4"
  style="background: color-mix(in srgb, var(--bg) 80%, transparent);"
>
  <button
    type="button"
    data-testid="help-backdrop"
    aria-label="Close help"
    class="absolute inset-0 h-full w-full cursor-default"
    onclick={onClose}
  ></button>

  <div
    class="relative z-10 w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text-primary)]"
  >
    <div class="mb-3 flex items-center justify-between">
      <h2 class="m-0 text-base font-semibold">Keyboard shortcuts</h2>
      <button
        type="button"
        data-testid="help-close"
        aria-label="Close help"
        onclick={onClose}
        class="min-h-[44px] min-w-[44px] rounded border border-[var(--border)] bg-[var(--bg)] text-sm text-[var(--text-muted)]"
      >
        ✕
      </button>
    </div>
    <dl class="m-0 flex flex-col gap-2 text-sm">
      <div class="flex items-center justify-between gap-4">
        <dt class="text-[var(--text-muted)]">Toggle JSON on the focused entry</dt>
        <dd class="m-0 font-mono text-[var(--text-primary)]">J</dd>
      </div>
      <div class="flex items-center justify-between gap-4">
        <dt class="text-[var(--text-muted)]">Open this help</dt>
        <dd class="m-0 font-mono text-[var(--text-primary)]">?</dd>
      </div>
      <div class="flex items-center justify-between gap-4">
        <dt class="text-[var(--text-muted)]">Close this help</dt>
        <dd class="m-0 font-mono text-[var(--text-primary)]">Esc</dd>
      </div>
    </dl>
  </div>
</div>
