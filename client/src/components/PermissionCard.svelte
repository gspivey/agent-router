<script lang="ts">
  /**
   * Permission request card (spa-overhaul Task 5 / ROADMAP 75).
   *
   * Full-width READ-ONLY card for a `permission` parsed entry (Requirement 6.5).
   * It shows ONLY the request title — what the agent is asking permission for —
   * and renders NO Accept / Decline or any other action control. Permission
   * responses are out of scope for this spec (there is no backend endpoint for
   * them, NFR-2.1), so the card is purely informational.
   */
  interface Props {
    title: string;
  }

  const { title }: Props = $props();
</script>

<div
  data-testid="permission-card"
  class="my-1 w-full rounded-lg border border-[var(--warning)] bg-[var(--tool-card-bg)] px-3 py-2"
>
  <p class="m-0 text-xs font-medium uppercase tracking-wide text-[var(--warning)]">
    Permission requested
  </p>
  <p class="m-0 mt-1 max-w-full break-words text-sm text-[var(--text-primary)]" style="overflow-wrap: anywhere;">
    {title}
  </p>
</div>
