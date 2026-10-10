<script lang="ts">
  /**
   * Prompt composer (spa-overhaul Task 6 / ROADMAP 76).
   *
   * An ALWAYS-visible bar (Requirement 7.6) containing a text input and a Send
   * button that injects a prompt into the session via `api.inject(id, prompt)`.
   * The input font is ≥16 px to prevent iOS auto-zoom (Requirement 8.7). On
   * mobile/tablet the caller renders this as a fixed bottom bar above the detail
   * bar with `padding-bottom: env(safe-area-inset-bottom)`.
   *
   * When `disabled` is true (the session has ended — Requirement 7.8) the input
   * and Send button stay VISIBLE but become inert. The parent owns the API call
   * so the composer is a pure, testable presentational component: it reports a
   * submitted prompt via `onSend` and clears its own input on a successful send.
   */
  interface Props {
    /** Called with the trimmed prompt text; returns the inject promise. */
    onSend: (prompt: string) => Promise<void>;
    /** When true the composer is visible but inert (session ended). */
    disabled?: boolean;
  }

  const { onSend, disabled = false }: Props = $props();

  let value = $state('');
  let sending = $state(false);

  const canSend = $derived(!disabled && !sending && value.trim() !== '');

  async function submit(event?: Event): Promise<void> {
    event?.preventDefault();
    const prompt = value.trim();
    if (prompt === '' || disabled || sending) return;
    sending = true;
    try {
      await onSend(prompt);
      value = ''; // clear only on success
    } catch {
      // Leave the text in place so the operator can retry; the parent surfaces
      // any auth/API error state.
    } finally {
      sending = false;
    }
  }
</script>

<form
  data-testid="composer"
  class="flex items-center gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2"
  onsubmit={submit}
>
  <input
    data-testid="composer-input"
    type="text"
    autocomplete="off"
    placeholder="Send a prompt…"
    bind:value
    disabled={disabled}
    class="min-h-[44px] min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-3 text-base text-[var(--text-primary)] disabled:opacity-50"
  />
  <button
    data-testid="composer-send"
    type="submit"
    disabled={!canSend}
    class="min-h-[44px] min-w-[44px] rounded bg-[var(--agent-bubble-bg)] px-4 text-sm font-medium text-[var(--agent-bubble-text)] disabled:opacity-50"
  >
    Send
  </button>
</form>
