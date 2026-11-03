<script lang="ts">
  /**
   * A collapsible repo section in the grouped session list
   * (spa-operator-restoration ROADMAP 80, Task A-6).
   *
   * The header shows the repo name, an open-PR count badge (links to the repo's
   * PR list), a cron info / paused pill, and a pulsing green dot when any
   * session in the group is active — or an "idle" indicator when every session
   * in the group is inactive (FR-2.2 / spa-polish Req 14.2). The body lists all active sessions
   * plus a paged window of terminal sessions with a "Show more" button
   * (FR-2.4). Collapse state is persisted to localStorage with auto-collapse for
   * stale, inactive repos (FR-2.5, FR-2.6).
   *
   * HTML constraint: interactive elements (PR badge link, cron pill) are
   * SIBLINGS of the collapse `<button>` in the header flex row, never children,
   * because nesting interactive elements inside a `<button>` is invalid.
   *
   * Reactivity note: `terminalSessions`, `terminalTotal`, and `collapsed` are all
   * derived from the `group` prop so they stay up-to-date when the parent
   * auto-refreshes. Local mutations (loadMore, toggleCollapsed) use separate state
   * tracked alongside the prop-derived values.
   */
  import { api } from '../lib/api.js';
  import { formatDuration } from '../lib/logic.js';
  import type { RepoGroup, SessionSummary } from '../lib/types.js';
  import SessionCard from './SessionCard.svelte';

  interface Props {
    group: RepoGroup;
  }

  const { group }: Props = $props();

  /** One day in seconds — the auto-collapse staleness threshold (FR-2.6). */
  const STALE_SECONDS = 86_400;

  /**
   * Read the localStorage-persisted user override for collapse state.
   * Returns `'1'` (collapsed), `'0'` (expanded), or `null` (key absent → auto-collapse).
   */
  function readCollapsedOverride(repo: string): '1' | '0' | null {
    const key = `ar-repo-collapsed-${encodeURIComponent(repo)}`;
    const val = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (val === '1' || val === '0') return val;
    return null;
  }

  // ── collapse state ────────────────────────────────────────────────────────
  //
  // `collapsedOverride` holds the user's explicit choice (`'1'`/`'0'`) or null
  // when no override is active (meaning auto-collapse logic applies).
  // Initialized to null; the $effect below reads the stored preference on mount
  // and resets it whenever group.repo changes so a new repo starts with its own
  // stored state rather than inheriting the old repo's override.

  let collapsedOverride = $state<'1' | '0' | null>(null);

  $effect(() => {
    // Re-read the stored preference whenever group.repo changes (and on mount).
    collapsedOverride = readCollapsedOverride(group.repo);
  });

  /**
   * Derive the auto-collapse result reactively from the prop.
   * This re-runs whenever `group.active_sessions` or `group.terminal_sessions` change.
   */
  const autoCollapsed = $derived((): boolean => {
    if (group.terminal_sessions.length === 0) return false;
    const maxCompleted = Math.max(...group.terminal_sessions.map((s) => s.completed_at ?? 0));
    if (maxCompleted <= 0) return false;
    return group.active_sessions.length === 0 && Date.now() / 1000 - maxCompleted > STALE_SECONDS;
  });

  /** The effective collapsed state: user override wins; fall back to auto-collapse. */
  const collapsed = $derived(
    collapsedOverride === '1' ? true : collapsedOverride === '0' ? false : autoCollapsed(),
  );

  function toggleCollapsed(): void {
    const next = !collapsed;
    collapsedOverride = next ? '1' : '0';
    const key = `ar-repo-collapsed-${encodeURIComponent(group.repo)}`;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, next ? '1' : '0');
    }
  }

  // ── terminal sessions (server page + loadMore extra pages) ────────────────
  //
  // `loadedPages` is a Map from `repoKey` to the extra sessions fetched via "Show
  // more" for that repo. Using a Map keyed by repo means a new repo always starts
  // with an empty extra list, and we don't need a separate $effect reset.
  //
  // The rendered list is:
  //   [server first page] + [extras for this repo not already in the first page]
  //
  // The de-duplication handles sessions that were in `extras` but have since been
  // promoted into the server's default window on the next auto-refresh.

  let loadedPages = $state(new Map<string, SessionSummary[]>());

  const terminalSessions = $derived((): SessionSummary[] => {
    const extras = loadedPages.get(group.repo) ?? [];
    const serverIds = new Set(group.terminal_sessions.map((s) => s.session_id));
    const filteredExtras = extras.filter((s) => !serverIds.has(s.session_id));
    return [...group.terminal_sessions, ...filteredExtras];
  });

  // ── terminal total ────────────────────────────────────────────────────────
  //
  // `totalByRepo` tracks the most-recent total from either the server prop or a
  // `loadMore` API call. When a `loadMore` response arrives it stores a higher
  // total; when the prop updates with an authoritative total the $derived uses
  // whichever is larger (handles the race where `loadMore` fires just before the
  // next auto-refresh).

  let totalByRepo = $state(new Map<string, number>());

  const terminalTotal = $derived(
    Math.max(group.terminal_total, totalByRepo.get(group.repo) ?? 0),
  );

  // ── remaining count + loadMore ────────────────────────────────────────────

  let loadingMore = $state(false);
  let loadMoreError = $state<string | null>(null);

  const remaining = $derived(terminalTotal - terminalSessions().length);

  async function loadMore(): Promise<void> {
    loadingMore = true;
    loadMoreError = null;
    try {
      const res = await api.listRepoPagedSessions(group.repo, 5, terminalSessions().length);
      // De-duplicate by session_id to handle sessions that ended between fetches.
      const existingIds = new Set(terminalSessions().map((s) => s.session_id));
      const newSessions = res.sessions.filter((s) => !existingIds.has(s.session_id));
      const existing = loadedPages.get(group.repo) ?? [];
      loadedPages = new Map(loadedPages).set(group.repo, [...existing, ...newSessions]);
      totalByRepo = new Map(totalByRepo).set(group.repo, res.total);
    } catch {
      loadMoreError = 'Failed to load more sessions.';
    } finally {
      loadingMore = false;
    }
  }

  /** Format the time until the next cron fire; "soon" when already past. */
  function formatNextFire(isoString: string): string {
    const diffMs = Date.parse(isoString) - Date.now();
    if (Number.isNaN(diffMs) || diffMs <= 0) return 'soon';
    return formatDuration(Math.round(diffMs / 1000));
  }

  const encodedRepo = $derived(encodeURIComponent(group.repo));
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
    {:else}
      <span
        data-testid="group-paused"
        aria-label="No active sessions"
        class="shrink-0 rounded-full bg-[var(--system-pill-bg)] px-2 py-0.5 text-xs text-[var(--text-muted)]"
      >idle</span>
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
      {#each terminalSessions() as session (session.session_id)}
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
