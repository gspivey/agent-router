<script lang="ts">
  /**
   * A single session row in the list (spa-overhaul Task 4 / ROADMAP 74).
   *
   * Displays the session's status badge (color via `statusToBadge`), repository
   * name, creation timestamp, and `waiting_for` value when present
   * (Requirement 5.1, 5.2). The card is at least 72 CSS pixels tall and spans
   * the full content width below 768 px (Requirement 5.5); activating it
   * navigates to the chat route (Requirement 5.6). Its tap target is well above
   * 44×44 CSS pixels (Requirement 5.7).
   */
  import { statusToBadge, formatDuration, prUrl, type BadgeColor } from '../lib/logic.js';
  import type { SessionSummary } from '../lib/types.js';
  import { goToSession } from '../routes/router.svelte.js';

  interface Props {
    session: SessionSummary;
  }

  const { session }: Props = $props();

  /** Map a badge color to its palette custom property (Requirement 5.2). */
  const BADGE_COLOR_VAR: Record<BadgeColor, string> = {
    green: 'var(--success)',
    gray: 'var(--text-muted)',
    yellow: 'var(--warning)',
    red: 'var(--error)',
  };

  const badge = $derived(statusToBadge(session.status));
  const badgeColor = $derived(BADGE_COLOR_VAR[badge]);

  /** First 8 chars of the session UUID (FR-1.1). */
  const shortId = $derived(session.session_id.slice(0, 8));

  /** Termination pill shown only for ended sessions with a reason (FR-1.3). */
  const showTermination = $derived(
    session.termination_reason !== null && session.status !== 'active',
  );

  /** Duration shown only for ended sessions with a completed_at (FR-1.4). */
  const durationLabel = $derived(
    session.status !== 'active' && session.completed_at !== null
      ? formatDuration(session.completed_at - session.created_at)
      : '',
  );

  /** Format a unix-seconds timestamp into a short, locale-aware label. */
  function formatCreated(createdAt: number): string {
    const d = new Date(createdAt * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString();
  }

  function open(): void {
    goToSession(session.session_id);
  }
</script>

<div
  data-testid="session-card-wrapper"
  class="flex flex-col border-b border-[var(--border)] bg-[var(--surface)]"
>
  <button
    type="button"
    data-testid="session-card"
    data-session-id={session.session_id}
    data-status={session.status}
    onclick={open}
    class="flex min-h-[72px] w-full min-w-0 items-center gap-3 px-4 py-3 text-left"
  >
    <span
      data-testid="status-badge"
      data-badge={badge}
      class="inline-flex items-center gap-2 rounded-full px-2 py-1 text-xs font-medium"
      style="color: {badgeColor}; border: 1px solid {badgeColor};"
    >
      <span
        aria-hidden="true"
        class="inline-block h-2 w-2 rounded-full"
        style="background: {badgeColor};"
      ></span>
      {session.status}
    </span>

    <span class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-sm font-medium text-[var(--text-primary)]">
        {session.repo ?? 'no repo'}
      </span>
      <span
        data-testid="session-subtitle"
        class="flex min-w-0 items-center gap-2 break-words line-clamp-2 text-xs text-[var(--text-muted)]"
        style="overflow-wrap: anywhere;"
      >
        <span data-testid="short-id" class="font-mono">{shortId}</span>
        <span>{formatCreated(session.created_at)}</span>
      </span>
    </span>

    <span class="flex shrink-0 flex-col items-end gap-1">
      {#if session.waiting_for}
        <span
          data-testid="waiting-for"
          class="rounded-full bg-[var(--system-pill-bg)] px-2 py-1 text-xs text-[var(--system-pill-text)]"
        >
          {session.waiting_for}
        </span>
      {/if}
      {#if showTermination}
        <span
          data-testid="termination-reason"
          class="inline-block rounded-full bg-[var(--system-pill-bg)] px-2 py-0.5 text-xs text-[var(--text-muted)]"
        >
          {session.termination_reason}
        </span>
      {/if}
      {#if durationLabel !== ''}
        <span data-testid="session-duration" class="text-xs text-[var(--text-muted)]">
          {durationLabel}
        </span>
      {/if}
    </span>
  </button>

  {#if session.prs.length > 0}
    <span data-testid="pr-links" class="flex flex-wrap gap-1 px-4 pb-2 text-xs">
      {#each session.prs as pr, i (pr.repo + '#' + pr.pr_number)}
        {#if i > 0}<span aria-hidden="true">,&nbsp;</span>{/if}
        <a
          data-testid="pr-link"
          href={prUrl(pr.repo, pr.pr_number)}
          target="_blank"
          rel="noopener noreferrer"
          class="text-[var(--tool-card-accent)]"
        >PR #{pr.pr_number}</a>
      {/each}
    </span>
  {/if}
</div>
