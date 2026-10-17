<script lang="ts">
  /**
   * Agent message bubble (spa-overhaul Task 5 / ROADMAP 75; `bare` prop added in
   * spa-polish ROADMAP 88).
   *
   * Two modes:
   *
   * - **Default (`bare = false`):** a right-aligned bubble for `agent_chunk` /
   *   `agent_message` parsed entries (Requirement 6.2). Content is rendered as
   *   **plain text** — Svelte's text interpolation escapes the payload by
   *   construction, so no markup or script can be injected. This is the legacy
   *   v1 path, kept for compatibility (NFR-5).
   *
   * - **Bare (`bare = true`):** the agent text is rendered through the sanitized
   *   markdown path (`renderMarkdown()` from `chat-render.ts` / `logic.ts`),
   *   WITHOUT the outer right-aligning wrapper div. This lets `MessageRow`
   *   (spa-polish ROADMAP 88) supply its own bubble wrapper while delegating the
   *   agent markdown to the single sanctioned `{@html}` sink (NFR-1 / Req 11.7).
   *   `renderMarkdown()` escapes HTML up front, so hostile content cannot inject
   *   markup or script.
   *
   * Consecutive streaming chunks are reassembled into one bubble by the caller
   * (`ChatView`), which concatenates their text in id order and passes the final
   * string here. Below 768 px the bubble is constrained to `max-w-[85vw]`
   * (Requirement 6.8) and long content wraps rather than overflowing (HIGH-13).
   *
   * When `cursor` is true (live streaming, Task 6 / Requirement 7.2) a pulsing
   * `▌` glyph is appended to signal the agent is still typing. The caller
   * computes `cursor`; this component only renders it.
   */
  import { renderMarkdown } from '../lib/logic.js';

  interface Props {
    /** The bubble text (plain text; already reassembled for streaming turns). */
    text: string;
    /** Show the pulsing streaming cursor glyph (Requirement 7.2). */
    cursor?: boolean;
    /**
     * Render only the bubble content (via sanitized markdown), omitting the
     * outer right-aligning wrapper so a caller can supply its own
     * (spa-polish ROADMAP 88, Req 11.7). The cursor is not shown in bare mode;
     * `MessageRow` manages streaming affordances itself.
     */
    bare?: boolean;
  }

  const { text, cursor = false, bare = false }: Props = $props();

  const html = $derived(renderMarkdown(text));
</script>

{#if bare}
  <!-- Bare: sanitized markdown, no wrapper. The single sanctioned {@html} sink
       (renderMarkdown escapes HTML first). MessageRow supplies the wrapper. -->
  <div data-testid="message-bubble" class="whitespace-pre-wrap break-words text-sm" style="overflow-wrap: anywhere;"><span>{@html html}</span>{#if cursor}<span data-testid="stream-cursor" class="ml-0.5 inline-block animate-pulse" aria-hidden="true">▌</span>{/if}</div>
{:else}
  <div data-testid="message-bubble" class="flex w-full justify-end">
    <div
      class="my-1 max-w-[85vw] whitespace-pre-wrap break-words rounded-2xl bg-[var(--agent-bubble-bg)] px-3 py-2 text-sm text-[var(--agent-bubble-text)] md:max-w-[70%]"
      style="overflow-wrap: anywhere;"
    >{text}{#if cursor}<span data-testid="stream-cursor" class="ml-0.5 inline-block animate-pulse" aria-hidden="true">▌</span>{/if}</div>
  </div>
{/if}
