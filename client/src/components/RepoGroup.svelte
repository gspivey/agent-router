<script lang="ts">
  /**
   * A collapsible repo section in the grouped session list
   * (spa-operator-restoration ROADMAP 80, Task A-6).
   *
   * The header shows the repo name, an open-PR count badge (links to the repo's
   * PR list), a cron info / paused pill, and a pulsing green dot when any
   * session in the group is active (FR-2.2). The body lists all active sessions
   * plus a paged window of terminal sessions with a "Show more" button
   * (FR-2.4). Collapse state is persisted to localStorage with auto-collapse for
   * stale, inactive repos (FR-2.5, FR-2.6).
   *
   * HTML constraint: interactive elements (PR badge link, cron pill) are
   * SIBLINGS of the collapse `<button>` in the header flex row, never children,
   * because nesting interactive elements inside a `<button>` is invalid.
   */
  import { api } from '../lib/api.js';
  import { formatDuration } from '../lib/logic.js';
  import type { RepoGroup, SessionSummary } from '../lib/types.js';
  import SessionCard from './SessionCard.svelte';

  interface Props {
    group: RepoGroup;
  }

  const { group }: Props = $props();

  /** localStorage-safe key suffix and aria-controls target id. */
  const encodedRepo = encodeURIComponent(group.repo);

  /** One day in seconds — the auto-collapse staleness threshold (FR-2.6). */
  const STALE_SECONDS = 86_400;

  /**
   * Decide the initial collapse state for this repo (FR-2.5 / FR-2.6).
   * - localStorage `"1"` → collapsed; `"0"` → expanded (overrides auto-collapse).
   * - key absent → apply auto-collapse: no active sessions AND the newest
   *   terminal session completed more than a day ago.
   */
  function loadCollapsed(repo: string): boolean {
    const key = `ar-repo-collapsed-${encodeURIComponent(repo)}`;
    const val = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (val === '1') return true;
    if (val === '0') return false;
    // Key absent — auto-collapse rule.
    if (group.terminal_sessions.length === 0) return false;
    const maxCompleted = Math.max(...group.terminal_sessions.map((s) => s.completed_at ?? 0));
    if (maxCompleted <= 0) return false;
    return group.active_sessions.length === 0 && Date.now() / 1000 - maxCompleted > STALE_SECONDS;
  }

  let collapsed = $state(loadCollapsed(group.repo));
  let terminalSessions = $state<SessionSummary[]>([...group.terminal_sessions]);
  let terminalTotal = $state(group.terminal_total);
  let loadingMore = $state(false);
  let loadMoreError = $state<string | null>(null);

  function toggleCollapsed(): void {
    collapsed = !collapsed;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`ar-repo-collapsed-${encodedRepo}`, collapsed ? '1' : '0');
    }
  }

  /** Format the time until the next cron fire; "soon" when already past. */
  function formatNextFire(isoString: string): string {
    const diffMs = Date.parse(isoString) - Date.now();
    if (Number.isNaN(diffMs) || diffMs <= 0) return 'soon';
    return formatDuration(Math.round(diffMs / 1000));
  }

  async function loadMore(): Promise<void> {
    loadingMore = true;
    loadMoreError = null;
    try {
      const res = await api.listRepoPagedSessions(group.repo, 5, terminalSessions.length);
      // De-duplicate by session_id to handle sessions that ended between fetches.
      const existingIds = new Set(terminalSessions.map((s) => s.session_id));
      const newSessions = res.sessions.filter((s) => !existingIds.has(s.session_id));
      terminalSessions = [...terminalSessions, ...newSessions];
      terminalTotal = res.total;
    } catch {
      loadMoreError = 'Failed to load more sessions.';
    } finally {
      loadingMore = false;
    }
  }

  const remaining = $derived(terminalTotal - terminalSessions.length);
</script>

<section data-testid="repo-group" data-repo={group.repo} class="flex flex-col">
  <div class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2">
    <button
      type="button"
      data-testid="repo-toggle"
      class="flex min-h-[44px] flex-1 items-center gap-2 text-left"
      onclick={toggleCollapsed}
      aria-expanded={!collapsed}
      aria-controls="repo-body-{encodedRepo}"
    >
      <span aria-hidden="true" class="text-xs text-[var(--text-muted)]">{collapsed ? '▸' : '▾'}</span>
      <span class="text-sm font-semibold text-[var(--text-primary)]">{group.repo}</span>
    </button>

    {#if group.active_sessions.length > 0}
      <span
        data-testid="active-dot"
        aria-label="Active sessions"
        class="inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--success)]"
        style="animation: pulse 2s infinite;"
      ></span>
    {/if}

    {#if group.open_pr_count > 0}
      <a
        data-testid="pr-count-badge"
        href="https://github.com/{group.repo}/pulls"
        target="_blank"
        rel="noopener noreferrer"
        class="shrink-0 text-xs text-[var(--tool-card-accent)]"
      >
        {group.open_pr_count} PR{group.open_pr_count > 1 ? 's' : ''}
      </a>
    {/if}

    {#if group.cron !== null}
      {#if group.cron.paused}
        <span
          data-testid="cron-paused"
          class="shrink-0 rounded-full bg-[var(--system-pill-bg)] px-2 py-0.5 text-xs text-[var(--text-muted)]"
        >paused</span>
      {:else if group.cron.next_fire !== null}
        <span data-testid="cron-info" class="shrink-0 text-xs text-[var(--text-muted)]">
          {group.cron.schedule} · next in {formatNextFire(group.cron.next_fire)}
        </span>
      {/if}
    {/if}
  </div>

  {#if !collapsed}
    <div id="repo-body-{encodedRepo}" data-testid="repo-body">
      {#each group.active_sessions as session (session.session_id)}
        <SessionCard {session} />
      {/each}
      {#each terminalSessions as session (session.session_id)}
        <SessionCard {session} />
      {/each}

      {#if remaining > 0}
        <button
          type="button"
          data-testid="show-more"
          class="min-h-[44px] w-full border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-left text-xs text-[var(--tool-card-accent)] disabled:opacity-50"
          onclick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : `Show ${remaining} more`}
        </button>
      {/if}

      {#if loadMoreError}
        <p data-testid="load-more-error" role="alert" class="p-2 text-xs text-[var(--error)]">
          {loadMoreError}
        </p>
      {/if}
    </div>
  {/if}
</section>
