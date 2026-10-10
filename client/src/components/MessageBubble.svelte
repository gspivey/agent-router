<script lang="ts">
  /**
   * Agent message bubble (spa-overhaul Task 5 / ROADMAP 75).
   *
   * Right-aligned bubble for `agent_chunk` / `agent_message` parsed entries
   * (Requirement 6.2). Content is rendered as **plain text** — there is NO raw
   * HTML directive anywhere in v1 (NFR-6.2 / HIGH-D), so Svelte's text
   * interpolation escapes the payload by construction and no markup or script
   * can be injected. Markdown rendering (`renderMarkdown`) is v2 future work and
   * is deliberately NOT wired here.
   *
   * Consecutive streaming chunks are reassembled into one bubble by the caller
   * (`ChatView`), which concatenates their text in id order and passes the final
   * string here. Below 768 px the bubble is constrained to `max-w-[85vw]`
   * (Requirement 6.8) and long content wraps rather than overflowing the chat
   * container (HIGH-13).
   *
   * When `cursor` is true (live streaming, Task 6 / Requirement 7.2) a pulsing
   * `▌` glyph is appended to the bubble to signal the agent is still typing.
   * The caller computes `cursor` from the streaming state; this component only
   * renders it.
   */
  interface Props {
    /** The bubble text (plain text; already reassembled for streaming turns). */
    text: string;
    /** Show the pulsing streaming cursor glyph (Requirement 7.2). */
    cursor?: boolean;
  }

  const { text, cursor = false }: Props = $props();
</script>

<div data-testid="message-bubble" class="flex w-full justify-end">
  <div
    class="my-1 max-w-[85vw] whitespace-pre-wrap break-words rounded-2xl bg-[var(--agent-bubble-bg)] px-3 py-2 text-sm text-[var(--agent-bubble-text)] md:max-w-[70%]"
    style="overflow-wrap: anywhere;"
  >{text}{#if cursor}<span data-testid="stream-cursor" class="ml-0.5 inline-block animate-pulse" aria-hidden="true">▌</span>{/if}</div>
</div>
