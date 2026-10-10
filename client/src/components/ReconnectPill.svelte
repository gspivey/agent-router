<script lang="ts">
  /**
   * Reconnect indicator pill (spa-overhaul Task 6 / ROADMAP 76).
   *
   * A transient, horizontally centered pill reading `Reconnecting…`, shown by
   * `ChatView` while the SSE connection status is `reconnecting` and removed
   * once the stream is `live` again (Requirement 7.4 / 4.9). Purely presentational;
   * the caller controls visibility. All colors reference the Requirement 1.7
   * custom properties (no hardcoded hex — Requirement 8.3).
   */
</script>

<div data-testid="reconnect-pill" class="pointer-events-none sticky top-14 z-10 flex w-full justify-center py-1">
  <span
    class="rounded-full border border-[var(--warning)] bg-[var(--system-pill-bg)] px-3 py-1 text-xs text-[var(--warning)]"
    role="status"
    aria-live="polite"
  >
    Reconnecting…
  </span>
</div>
