<script lang="ts">
  /**
   * Status pill shared primitive (spa-polish ROADMAP 87, Req 3).
   *
   * Renders an inline pill with a leading colored dot and a text label so cron
   * and session states read at a glance. The dot is `aria-hidden`; the text
   * label is always present (no color-only meaning) so screen readers announce
   * the state (Req 3.3 / 14.4). All colors reference `app.css` tokens (NFR-2).
   */
  type BadgeState = 'active' | 'paused' | 'error';

  interface Props {
    state: BadgeState;
    /** Overrides the default label text (e.g. "Healthy", "Degraded"). */
    label?: string;
  }

  const { state, label }: Props = $props();

  /** Dot color per state, from the palette tokens (Req 3.2). */
  const DOT: Record<BadgeState, string> = {
    active: 'var(--success)',
    paused: 'var(--warning)',
    error: 'var(--error)',
  };

  /** Default label per state when no `label` override is supplied (Req 3.2). */
  const DEFAULT_LABEL: Record<BadgeState, string> = {
    active: 'Active',
    paused: 'Paused',
    error: 'Error',
  };
</script>

<span
  data-testid="status-badge"
  data-state={state}
  class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
>
  <span
    aria-hidden="true"
    class="h-2 w-2 rounded-full"
    style="background: {DOT[state]};"
  ></span>
  {label ?? DEFAULT_LABEL[state]}
</span>
