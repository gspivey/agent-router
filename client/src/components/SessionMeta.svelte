<script lang="ts">
  /**
   * Session metadata panel (spa-operator-restoration Task B-5 / ROADMAP 81).
   *
   * A collapsible panel rendered above the chat stream in the detail view
   * (FR-3.1). It shows the full session UUID (monospace, with a copy button),
   * the status badge, repo link, created / completed datetimes, duration,
   * termination reason, and PR links. Rows that depend on a value only present
   * for ended sessions (completed-at, duration, termination reason) are omitted
   * when that value is absent (AC-3.1b).
   *
   * The panel is collapsed by default below 768 px and expanded at ≥768 px
   * (FR-3.2); the operator may toggle it at any time. The collapse state is
   * local — it is NOT persisted and resets on navigation.
   */
  import { statusToBadge, formatDuration, prUrl, type BadgeColor } from '../lib/logic.js';
  import type { SessionMeta } from '../lib/types.js';

  interface Props {
    meta: SessionMeta;
  }

  const { meta }: Props = $props();

  /** Map a badge color to its palette custom property. */
  const BADGE_COLOR_VAR: Record<BadgeColor, string> = {
    green: 'var(--success)',
    gray: 'var(--text-muted)',
    yellow: 'var(--warning)',
    red: 'var(--error)',
  };

  const badge = $derived(statusToBadge(meta.status));
  const badgeColor = $derived(BADGE_COLOR_VAR[badge]);

  // Expanded by default on wide viewports, collapsed on narrow ones (FR-3.2).
  // SSR-safe: `window` is undefined during server render.
  let expanded = $state(typeof window !== 'undefined' ? window.innerWidth >= 768 : true);

  const repo = $derived(meta.repo ?? null);
  const terminationReason = $derived(meta.termination_reason ?? null);

  /** Termination reason shown only when set and the session is not active. */
  const showTermination = $derived(terminationReason !== null && meta.status !== 'active');

  /** Duration shown only for ended sessions with a non-null completed_at. */
  const durationLabel = $derived(
    meta.status !== 'active' && meta.completed_at !== null
      ? formatDuration(meta.completed_at - meta.created_at)
      : '',
  );

  function formatTs(ts: number): string {
    const d = new Date(ts * 1000);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  function toggle(): void {
    expanded = !expanded;
  }

  async function copyId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(meta.session_id);
    } catch {
      // Clipboard write failures are silently ignored (design: Error Handling).
    }
  }
</script>

<section
  data-testid="session-meta-panel"
  class="border-b border-[var(--border)] bg-[var(--surface)]"
>
  <button
    type="button"
    data-testid="session-meta-toggle"
    onclick={toggle}
    aria-expanded={expanded}
    aria-controls="session-meta-body"
    class="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-[var(--text-primary)]"
  >
    <span aria-hidden="true" class="text-xs">{expanded ? '▾' : '▸'}</span>
    <span>Session Info</span>
  </button>

  {#if expanded}
    <dl id="session-meta-body" class="m-0 flex flex-col gap-1 px-3 pb-3 text-xs">
      <div class="flex items-center gap-2">
        <dt class="w-24 shrink-0 text-[var(--text-muted)]">Session ID</dt>
        <dd data-testid="session-id" class="m-0 min-w-0 flex-1 break-all font-mono">
          {meta.session_id}
        </dd>
        <button
          type="button"
          data-testid="session-id-copy"
          onclick={copyId}
          aria-label="Copy session ID"
          class="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[var(--text-muted)]"
        >
          Copy
        </button>
      </div>

      <div class="flex items-center gap-2">
        <dt class="w-24 shrink-0 text-[var(--text-muted)]">Status</dt>
        <dd class="m-0">
          <span
            data-testid="session-meta-status"
            class="inline-flex items-center gap-2 rounded-full px-2 py-0.5 font-medium"
            style="color: {badgeColor}; border: 1px solid {badgeColor};"
          >
            {meta.status}
          </span>
        </dd>
      </div>

      {#if repo !== null}
        <div class="flex items-center gap-2">
          <dt class="w-24 shrink-0 text-[var(--text-muted)]">Repo</dt>
          <dd class="m-0 min-w-0 flex-1 truncate">
            <a
              data-testid="session-meta-repo"
              href={`https://github.com/${repo}`}
              target="_blank"
              rel="noopener noreferrer"
              class="text-[var(--tool-card-accent)]"
            >{repo}</a>
          </dd>
        </div>
      {/if}

      <div class="flex items-center gap-2">
        <dt class="w-24 shrink-0 text-[var(--text-muted)]">Created</dt>
        <dd data-testid="session-meta-created" class="m-0">{formatTs(meta.created_at)}</dd>
      </div>

      {#if meta.completed_at !== null}
        <div class="flex items-center gap-2">
          <dt class="w-24 shrink-0 text-[var(--text-muted)]">Completed</dt>
          <dd data-testid="session-meta-completed" class="m-0">{formatTs(meta.completed_at)}</dd>
        </div>
      {/if}

      {#if durationLabel !== ''}
        <div class="flex items-center gap-2">
          <dt class="w-24 shrink-0 text-[var(--text-muted)]">Duration</dt>
          <dd data-testid="session-meta-duration" class="m-0">{durationLabel}</dd>
        </div>
      {/if}

      {#if showTermination}
        <div class="flex items-center gap-2">
          <dt class="w-24 shrink-0 text-[var(--text-muted)]">Terminated</dt>
          <dd data-testid="session-meta-termination" class="m-0">{terminationReason}</dd>
        </div>
      {/if}

      {#if meta.prs.length > 0}
        <div class="flex items-center gap-2">
          <dt class="w-24 shrink-0 text-[var(--text-muted)]">PRs</dt>
          <dd data-testid="session-meta-prs" class="m-0 flex flex-wrap gap-1">
            {#each meta.prs as pr, i (pr.repo + '#' + pr.pr_number)}
              {#if i > 0}<span aria-hidden="true">,&nbsp;</span>{/if}
              <a
                data-testid="session-meta-pr-link"
                href={prUrl(pr.repo, pr.pr_number)}
                target="_blank"
                rel="noopener noreferrer"
                class="text-[var(--tool-card-accent)]"
              >PR #{pr.pr_number}</a>
            {/each}
          </dd>
        </div>
      {/if}
    </dl>
  {/if}
</section>
