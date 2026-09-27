/**
 * `selectWorkingState` — drives the new "agent is working" surface
 * (the Footline + Margin Draft) over `AgentSessionState`.
 *
 * Design rationale: `docs/design/agent-working-experience.html`.
 *
 * One pure function; called once per render via `useMemo`. Builds:
 *   - the present-participle **verb** ("reading", "drafting", …)
 *   - the **object** of that verb (a file path, a command, a count)
 *   - the wall-clock **since** that started
 *   - one or two italic **marginDraftLines** of recent narration
 *
 * The selector is intentionally exhaustive about verb classification —
 * the more specific the verb, the more useful the surface.  Unknown
 * tools fall through to a generic "running" verb with the tool name as
 * the object.
 */
import type { AgentSessionState, RenderedMessage } from "./messageStore";
import type { ContentBlock, ToolUseBlockData } from "./types";
import { isTextBlock, isThinkingBlock, isToolUseBlock } from "./types";
import {
  selectSubagentCounts,
  type SubagentCounts,
} from "./subagentSelectors";

export type WorkingVerb =
  | "idle"
  | "awaiting"
  | "thinking"
  | "reading"
  | "writing"
  | "running"
  | "searching"
  | "fetching"
  | "coordinating"
  | "drafting"
  | "waiting"
  | "stopping";

/** A small descriptor of the object the verb operates on. */
export interface WorkingObject {
  /** Path-shaped string (read/write/search-target). */
  path?: string;
  /** Command-shaped string (bash, run). */
  command?: string;
  /** URL (web fetch). */
  url?: string;
  /** Search pattern (grep, glob). */
  pattern?: string;
  /** Editorial descriptor (e.g. "reply · ~620 tokens", "first byte"). */
  descriptor?: string;
  /** Subagent aggregate ("2 of 3 subagents · 1 done"). */
  subagents?: SubagentCounts;
  /** Free-form fallback. */
  raw?: string;
}

export interface WorkingState {
  /** True iff the agent is non-idle (anything to surface). */
  active: boolean;
  /** Present-participle verb of the current activity. */
  verb: WorkingVerb;
  /** What the verb operates on, if any. */
  object: WorkingObject;
  /** Wall-clock ms when this activity started.  Null when not in
   *  flight.  Drives the chronograph. */
  since: number | null;
  /** Cumulative output tokens this turn (lifts the existing
   *  `state.cumulativeOutputTokens` so the surface doesn't have to
   *  reach into state separately).  Tabular in the footline. */
  cumulativeOutputTokens: number;
  /** Up to two lines of italic narration to show in the Margin Draft.
   *  Index 0 = the older line; index 1 = the freshest.  Empty array
   *  when nothing is worth showing. */
  marginDraftLines: string[];
  /** Convenience: the in-flight tool_use (if any) so the consumer can
   *  jump to its block on click.  Null when there is no in-flight
   *  tool. */
  runningTool: { id: string; name: string; input: Record<string, unknown> } | null;
}

/* ─── internal helpers ─────────────────────────────────────────────── */

/** Find the assistant message currently being streamed, if any. */
function findStreamingMessage(
  state: AgentSessionState,
): RenderedMessage | null {
  if (!state.streamingMessageId) return null;
  return (
    state.messages.find(
      (m) => m.role === "assistant" && m.id === state.streamingMessageId,
    ) ?? null
  );
}

/** Find the tool_use whose id is in `runningToolUseIds`, walking
 *  newest-first.  Returns the most recently observed in-flight tool. */
function findRunningTool(
  state: AgentSessionState,
): ToolUseBlockData | null {
  if (state.runningToolUseIds.size === 0) return null;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role !== "assistant") continue;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j];
      if (isToolUseBlock(b) && state.runningToolUseIds.has(b.id)) {
        return b;
      }
    }
  }
  return null;
}

/** Map a tool name (case-insensitive, hyphen/underscore-stripped) to a
 *  verb.  Falls through to `"running"` for the unknown long tail. */
function verbForTool(name: string): WorkingVerb {
  const k = name.toLowerCase().replace(/[\s_-]/g, "");
  if (k === "read" || k === "notebookread") return "reading";
  if (k === "write" || k === "edit" || k === "notebookedit") return "writing";
  if (k === "bash" || k === "run" || k === "shell") return "running";
  if (k === "grep" || k === "glob") return "searching";
  if (k === "webfetch" || k === "websearch") return "fetching";
  if (k === "task" || k === "agent" || k === "agentdispatch") return "coordinating";
  return "running";
}

/** Pull a useful object descriptor out of a tool's input.  Falls
 *  through to a one-line JSON-ish hint when nothing of the known
 *  shape matches. */
function objectForTool(tool: ToolUseBlockData): WorkingObject {
  const input = tool.input ?? {};
  const get = (k: string): string | undefined => {
    const v = (input as Record<string, unknown>)[k];
    return typeof v === "string" ? v : undefined;
  };

  if (get("file_path") || get("path") || get("filePath")) {
    return { path: get("file_path") ?? get("path") ?? get("filePath") };
  }
  if (get("command") || get("cmd") || get("shell")) {
    return { command: get("command") ?? get("cmd") ?? get("shell") };
  }
  if (get("url") || get("endpoint")) {
    return { url: get("url") ?? get("endpoint") };
  }
  if (get("pattern") || get("query") || get("search")) {
    return { pattern: get("pattern") ?? get("query") ?? get("search") };
  }
  if (get("description")) {
    return { descriptor: get("description") };
  }
  return { raw: tool.name };
}

/** Trim a long string to a single-line preview suitable for the
 *  Margin Draft. */
function previewLine(s: string, maxLen = 140): string {
  const oneline = s.replace(/\s+/g, " ").trim();
  return oneline.length > maxLen ? oneline.slice(0, maxLen - 1).trimEnd() + "…" : oneline;
}

/** Walk an assistant message and pull the latest text block content
 *  (the last N chars of its body, single-lined). */
function latestTextSnippet(message: RenderedMessage): string | null {
  for (let i = message.blocks.length - 1; i >= 0; i--) {
    const b = message.blocks[i];
    if (isTextBlock(b) && b.text.trim().length > 0) {
      return previewLine(b.text);
    }
  }
  return null;
}

/** Walk an assistant message's thinking blocks newest-first and pull
 *  the latest thinking text (raw block.thinking OR streaming
 *  accumulator). */
function latestThinkingSnippet(
  state: AgentSessionState,
  message: RenderedMessage,
): string | null {
  for (let i = message.blocks.length - 1; i >= 0; i--) {
    const b = message.blocks[i];
    if (!isThinkingBlock(b)) continue;
    const live = state.streamingThinkingText.get(`${message.id}:${i}`);
    const text = (b.thinking && b.thinking.trim().length > 0)
      ? b.thinking
      : (live ?? "");
    if (text.trim().length === 0) continue;
    return previewLine(text);
  }
  // No thinking block in the message blocks (yet) — but the SDK may be
  // shipping `thinking_delta` partials before the consolidated assistant
  // event lands. Fall back to ANY accumulator entry whose key starts
  // with this message's id.
  const prefix = `${message.id}:`;
  for (const [k, v] of state.streamingThinkingText) {
    if (!k.startsWith(prefix)) continue;
    if (v && v.trim().length > 0) return previewLine(v);
  }
  return null;
}

/** Last-resort snippet — pulls the longest non-empty value from the
 *  streaming-thinking accumulator regardless of which message it
 *  belongs to. Used when no streaming message is in `state.messages`
 *  yet but deltas are accumulating (the SDK has emitted
 *  `thinking_delta` partials before any consolidated `assistant`
 *  event).  Without this, the operator stares at the user-prompt
 *  fallback for the entire pre-first-byte phase even though the
 *  model is already reasoning. */
function anyStreamingThinkingSnippet(
  state: AgentSessionState,
): string | null {
  if (state.streamingThinkingText.size === 0) return null;
  // Newest accumulator entry wins.  Map iteration is insertion-order
  // in V8, so the last entry added is the freshest.
  let best: string | null = null;
  for (const v of state.streamingThinkingText.values()) {
    if (v && v.trim().length > 0) best = v;
  }
  return best ? previewLine(best) : null;
}

/** Take the LAST two coherent "fragments" out of a long text — split
 *  on sentence-end punctuation so the two lines feel like consecutive
 *  thoughts, not arbitrarily mid-clause cuts. */
function lastTwoFragments(text: string): string[] {
  const oneline = text.replace(/\s+/g, " ").trim();
  if (!oneline) return [];
  // Split on . ? ! followed by space/end.  Keep delimiters with the
  // preceding fragment for readability.
  const parts = oneline.match(/[^.?!]+[.?!]?(?=\s|$)/g) ?? [oneline];
  const meaningful = parts.map((p) => p.trim()).filter((p) => p.length > 4);
  const tail = meaningful.slice(-2);
  return tail.map((p) => previewLine(p));
}

/* ─── public API ───────────────────────────────────────────────────── */

export function selectWorkingState(state: AgentSessionState): WorkingState {
  const counts = selectSubagentCounts(state);
  const cumulativeOutputTokens = state.cumulativeOutputTokens;

  /* — Phase 1: pick the verb + object + since. — */

  // Running tool wins.  If a tool is in flight, the verb is its verb.
  const runningTool = findRunningTool(state);
  if (runningTool) {
    const verb = verbForTool(runningTool.name);
    // Special-cased: if the verb is "coordinating", surface aggregate
    // subagent counts instead of the Task tool's input.description.
    const object: WorkingObject =
      verb === "coordinating"
        ? { subagents: counts }
        : objectForTool(runningTool);
    const streamingMsg = findStreamingMessage(state);
    const since =
      streamingMsg?.timestamp
      ?? state.messages[state.messages.length - 1]?.timestamp
      ?? null;
    return {
      active: true,
      verb,
      object,
      since,
      cumulativeOutputTokens,
      marginDraftLines: marginDraftFor(state, "running"),
      runningTool: {
        id: runningTool.id,
        name: runningTool.name,
        input: runningTool.input,
      },
    };
  }

  // No tool in flight.  If a message is streaming, the agent is
  // either thinking or drafting (depending on which content block is
  // currently the tail).
  const streamingMsg = findStreamingMessage(state);
  if (streamingMsg) {
    // If the streaming message has a non-empty text block, the agent
    // is drafting prose; else it's still thinking.
    let tail: ContentBlock | null = null;
    for (let i = streamingMsg.blocks.length - 1; i >= 0; i--) {
      const b = streamingMsg.blocks[i];
      if (isTextBlock(b) && b.text.trim().length > 0) {
        tail = b;
        break;
      }
      if (isThinkingBlock(b)) {
        tail = b;
        break;
      }
    }

    if (tail && isTextBlock(tail)) {
      // Drafting — show approx token count of the current message's
      // streaming text as the object descriptor.  Token estimate
      // uses a 4-chars-per-token rule of thumb (good enough for a
      // chronograph display, not for billing).
      const tokenEstimate = Math.round(tail.text.length / 4);
      return {
        active: true,
        verb: "drafting",
        object: {
          descriptor:
            tokenEstimate > 0
              ? `reply · ~${tokenEstimate} tokens`
              : "reply",
        },
        since: streamingMsg.timestamp ?? null,
        cumulativeOutputTokens,
        marginDraftLines: marginDraftFor(state, "drafting"),
        runningTool: null,
      };
    }

    // No text block yet (or it's empty) — agent is still thinking.
    return {
      active: true,
      verb: "thinking",
      object: {},
      since: streamingMsg.timestamp ?? null,
      cumulativeOutputTokens,
      marginDraftLines: marginDraftFor(state, "thinking"),
      runningTool: null,
    };
  }

  // No streaming message, no running tool.  If the last message is
  // the user's, we're waiting for the first assistant byte UNLESS a
  // result event has already landed for this turn (interrupted
  // pre-stream — `deriveActivity` already handles this; we mirror).
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === "user") {
    const lastTs = last.timestamp ?? 0;
    const turnEnded =
      state.resultEventAt !== null && state.resultEventAt >= lastTs;
    if (!turnEnded) {
      // Pre-first-byte phase. If the SDK is already shipping
      // `thinking_delta` partials (no consolidated `assistant` event
      // has landed yet), promote the state from "awaiting" to
      // "thinking" so the operator sees the reasoning surface, not
      // the cold "first byte" descriptor.
      const liveThinking = anyStreamingThinkingSnippet(state);
      if (liveThinking) {
        const lines = lastTwoFragments(liveThinking);
        return {
          active: true,
          verb: "thinking",
          object: {},
          since: last.timestamp ?? null,
          cumulativeOutputTokens,
          marginDraftLines:
            lines.length > 0 ? lines : userPromptFallback(state),
          runningTool: null,
        };
      }
      return {
        active: true,
        verb: "awaiting",
        object: { descriptor: "first byte" },
        since: last.timestamp ?? null,
        cumulativeOutputTokens,
        // Awaiting state has no assistant narration yet — fall back
        // to the user's prompt so the operator always knows what
        // Claude is responding to.  Prefixed so it's read as context,
        // not as live agent narration.
        marginDraftLines: userPromptFallback(state),
        runningTool: null,
      };
    }
  }

  // Otherwise — idle.
  return {
    active: false,
    verb: "idle",
    object: {},
    since: null,
    cumulativeOutputTokens,
    marginDraftLines: [],
    runningTool: null,
  };
}

/** Build the Margin Draft lines.  Source priority:
 *    1. Live streaming text (drafting state)
 *    2. Live thinking text (thinking state)
 *    3. Latest committed text/thinking block (running state)
 *    4. Fallback: the user's last prompt (so the operator always
 *       has *some* context for what Claude is responding to even
 *       when the model doesn't surface its own narration)
 */
function marginDraftFor(
  state: AgentSessionState,
  mode: "thinking" | "drafting" | "running",
): string[] {
  const streamingMsg = findStreamingMessage(state);
  if (!streamingMsg) {
    // Even without a streaming message, the SDK may already be shipping
    // `thinking_delta` partials.  Surface them rather than falling
    // straight to the user-prompt context — the operator wants to see
    // the reasoning, not just what they typed.
    if (mode === "thinking") {
      const live = anyStreamingThinkingSnippet(state);
      if (live) {
        const lines = lastTwoFragments(live);
        if (lines.length > 0) return lines;
      }
    }
    return userPromptFallback(state);
  }

  if (mode === "drafting") {
    // Last two sentences of the streaming text block.
    const tailText = streamingMsg.blocks
      .filter(isTextBlock)
      .map((b) => b.text)
      .join("\n");
    const lines = lastTwoFragments(tailText);
    return lines.length > 0 ? lines : userPromptFallback(state);
  }

  if (mode === "thinking") {
    const thinkSnippet =
      latestThinkingSnippet(state, streamingMsg)
      ?? anyStreamingThinkingSnippet(state);
    if (thinkSnippet) {
      const lines = lastTwoFragments(thinkSnippet);
      if (lines.length > 0) return lines;
    }
    return userPromptFallback(state);
  }

  // Running mode — show the latest assistant narration (text or
  // thinking) so the operator knows what brought us into this tool.
  const txt = latestTextSnippet(streamingMsg);
  if (txt) {
    const lines = lastTwoFragments(txt);
    if (lines.length > 0) return lines;
  }
  const thinkSnippet = latestThinkingSnippet(state, streamingMsg);
  if (thinkSnippet) {
    const lines = lastTwoFragments(thinkSnippet);
    if (lines.length > 0) return lines;
  }
  return userPromptFallback(state);
}

/** Surface the most recent user message as Margin Draft context.
 *  Prefixed with a `RESPONDING TO` kicker so the eye reads it as
 *  the question the agent is answering, not as live agent
 *  narration.  Filters out tool_result user events — those aren't
 *  operator prompts.  The prefix is encoded inline via a sentinel
 *  so the MarginDraft component can split + style it separately
 *  without the selector returning a richer shape. */
export const MARGIN_DRAFT_FALLBACK_PREFIX = "​[responding to]​ ";

function userPromptFallback(state: AgentSessionState): string[] {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role !== "user") continue;
    // Skip user events that are pure tool_results — those aren't
    // operator prompts, they're the bridge echoing tool output back
    // into the conversation.
    const text = m.blocks
      .filter(isTextBlock)
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) continue;
    return [`${MARGIN_DRAFT_FALLBACK_PREFIX}${previewLine(text)}`];
  }
  return [];
}
