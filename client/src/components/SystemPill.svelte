<script lang="ts">
  /**
   * System event pill (spa-overhaul Task 5 / ROADMAP 75).
   *
   * Horizontally centered pill for `system` parsed entries (Requirement 6.3).
   * When the entry carries a `badge`, the pill text color maps to a palette
   * token: `green → --success`, `yellow → --warning`, `red → --error`. With no
   * badge it uses the muted system-pill tokens. All colors reference the
   * Requirement 1.7 custom properties (no hardcoded hex — Requirement 8.3).
   */
  import type { SystemBadge } from '../lib/logic.js';

  interface Props {
    text: string;
    badge?: SystemBadge | undefined;
  }

  const { text, badge }: Props = $props();

  /** Map a system badge to its palette custom property (Requirement 6.3). */
  const BADGE_COLOR_VAR: Record<SystemBadge, string> = {
    green: 'var(--success)',
    yellow: 'var(--warning)',
    red: 'var(--error)',
  };

  const color = $derived(badge ? BADGE_COLOR_VAR[badge] : 'var(--system-pill-text)');
</script>

<div data-testid="system-pill" data-badge={badge ?? 'none'} class="flex w-full justify-center">
  <span
    class="my-1 max-w-[85vw] break-words rounded-full bg-[var(--system-pill-bg)] px-3 py-1 text-center text-xs"
    style="color: {color}; overflow-wrap: anywhere;"
  >{text}</span>
</div>
