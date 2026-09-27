/**
 * Pure selectors over `AgentSessionState` for subagent visibility.
 *
 * No new state is added to the reducer — both selectors walk
 * `state.messages` on demand.  Callers wrap them in `useMemo` keyed
 * on `state.messages` + `state.runningToolUseIds`.
 *
 * See `docs/superpowers/specs/2026-05-12-subagent-visibility-design.md`
 * for the full design rationale, lifecycle, and edge cases.
 */

import type { AgentSessionState, RenderedMessage } from "./messageStore";
import type { ContentBlock, TextBlockData, ToolUseBlockData } from "./types";
import { isTextBlock, isToolUseBlock } from "./types";

/** A single subagent thread spawned by one Task tool_use. */
export interface SubagentRow {
  /** Root message id — the first message observed with this `parentToolUseId`. */
  id: string;
  /** First-line title from the Task input.description, else `subagent #N`. */
  name: string;
  /** Lifecycle state. */
  state: "thinking" | "running" | "done";
  /** ms timestamp the first message of this subagent landed. */
  since: number;
  /** ms timestamp the row entered `done`; null while running. */
  doneAt: number | null;
  /** Count of currently-running descendants at any depth. */
  nestedRunningCount: number;
  /** Most recent assistant text block in this subagent's transcript.
   *  Null if the subagent never spoke (immediate-failure case). */
  lastReply: TextBlockData | null;
  /** Every message in this subagent's thread (root + nested descendants). */
  transcript: RenderedMessage[];
}

export interface SubagentCounts {
  /** Subagents currently in `thinking` or `running` state, all depths. */
  running: number;
  /** Subagents that have entered `done` at any time this session. */
  done: number;
  /** Monotonic per session — every distinct subagent root id ever seen. */
  totalEverSpawned: number;
}

/* ─── Internal helpers ─────────────────────────────────────────────── */

/** Walk `state.messages` once and group them by the `parentToolUseId`
 *  that anchored each thread.  Returns a Map keyed by parentToolUseId
 *  (the tool_use.id of the Task call), with arrays of messages whose
 *  closest ancestor is that Task. */
function indexByDirectParent(
  state: AgentSessionState,
): Map<string, RenderedMessage[]> {
  const out = new Map<string, RenderedMessage[]>();
  for (const m of state.messages) {
    if (!m.parentToolUseId) continue;
    const bucket = out.get(m.parentToolUseId) ?? [];
    bucket.push(m);
    out.set(m.parentToolUseId, bucket);
  }
  return out;
}

/** Case-insensitive subagent-spawning tool detection.
 *
 *  Claude's SDK has shipped two names for the subagent-dispatch tool
 *  over time: `Task` (older fan-out pattern) and `agent` /
 *  `agent_dispatch` (newer managed-agent pattern).  Both are subagent
 *  spawners from our UI's perspective — they yield a row in the list
 *  and may have child messages with `parent_tool_use_id` pointing at
 *  their tool_use.id. */
export function isTaskTool(name: string): boolean {
  const k = name.toLowerCase().trim();
  return k === "task" || k === "agent" || k === "agent_dispatch";
}

/** Derive subagent state from the messages it owns + the global
 *  running-tools set.  See §3 in the spec. */
function deriveSubagentState(
  state: AgentSessionState,
  ownToolUseIds: string[],
  closingObserved: boolean,
): "thinking" | "running" | "done" {
  if (closingObserved) return "done";
  // If the parent turn ended, every still-open subagent is implicitly
  // done — this matches the existing B8 freeze in `messageStore`.
  if (state.resultEvent && !state.streamingMessageId) {
    return "done";
  }
  if (ownToolUseIds.some((id) => state.runningToolUseIds.has(id))) {
    return "running";
  }
  return "thinking";
}

/** Pick the title for a subagent from the parent Task tool_use's
 *  input.description, falling back to `subagent #N`. */
function nameForSubagent(
  parentToolUse: ToolUseBlockData | null,
  index: number,
): string {
  const description = parentToolUse?.input?.description;
  if (typeof description === "string" && description.trim().length > 0) {
    return description.trim().split("\n")[0].slice(0, 80);
  }
  return `subagent #${index + 1}`;
}

/** Walk an assistant message and return its latest text block. */
function latestTextBlock(blocks: ContentBlock[]): TextBlockData | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (isTextBlock(b)) return b;
  }
  return null;
}

/** Find the Task tool_use block with the given id by scanning every
 *  assistant message in the session.  O(n) over messages; called once
 *  per Task block render via memo. */
function findToolUseBlock(
  state: AgentSessionState,
  toolUseId: string,
): ToolUseBlockData | null {
  for (const m of state.messages) {
    if (m.role !== "assistant") continue;
    for (const block of m.blocks) {
      if (isToolUseBlock(block) && block.id === toolUseId) return block;
    }
  }
  return null;
}

/* ─── Public API ───────────────────────────────────────────────────── */

/**
 * Returns the direct subagents spawned by a single Task `tool_use`,
 * ordered by `since` ascending (oldest first — preserves spawn order).
 */
export function selectSubagentsForTool(
  state: AgentSessionState,
  toolUseId: string,
): SubagentRow[] {
  const byParent = indexByDirectParent(state);
  const direct = byParent.get(toolUseId);
  if (!direct || direct.length === 0) return [];

  const parentTool = findToolUseBlock(state, toolUseId);

  // Group direct children by their own root message id.  In Claude's
  // SDK, every assistant/user event from a single subagent invocation
  // shares the same root id (assistant id; user messages echo the same
  // id when paired).  But because user events (tool_result) can carry
  // their own ids, the safest "thread" key is the FIRST assistant
  // message id we observe with this parentToolUseId.  We anchor
  // threads on that.
  interface Thread {
    rootId: string;
    messages: RenderedMessage[];
  }
  const threads: Thread[] = [];
  const seenAssistantThread = new Set<string>();
  for (const m of direct) {
    if (m.role === "assistant") {
      if (!seenAssistantThread.has(m.id)) {
        seenAssistantThread.add(m.id);
        threads.push({ rootId: m.id, messages: [m] });
      } else {
        threads.find((t) => t.rootId === m.id)?.messages.push(m);
      }
    } else {
      // User events (tool_result) belong to the most recent open
      // thread for this parent.  Append to the last thread we saw.
      const last = threads[threads.length - 1];
      if (last) last.messages.push(m);
      else threads.push({ rootId: `user-${m.id}`, messages: [m] });
    }
  }

  // For each thread, compute its full transcript (including nested
  // descendants), state, and reply.
  const rows: SubagentRow[] = threads.map((thread, idx) => {
    const transcript: RenderedMessage[] = [...thread.messages];

    // Collect this subagent's own tool_use ids (so we can check
    // whether any of them are in state.runningToolUseIds).
    const ownToolUseIds: string[] = [];
    // Pull in nested descendants recursively.
    const queue: string[] = [];
    for (const m of thread.messages) {
      if (m.role !== "assistant") continue;
      for (const block of m.blocks) {
        if (isToolUseBlock(block)) {
          ownToolUseIds.push(block.id);
          if (isTaskTool(block.name)) queue.push(block.id);
        }
      }
    }
    while (queue.length > 0) {
      const taskId = queue.shift()!;
      const children = byParent.get(taskId);
      if (!children) continue;
      for (const c of children) {
        transcript.push(c);
        if (c.role !== "assistant") continue;
        for (const block of c.blocks) {
          if (isToolUseBlock(block)) {
            ownToolUseIds.push(block.id);
            if (isTaskTool(block.name)) queue.push(block.id);
          }
        }
      }
    }

    // A subagent has produced a closing event when its root
    // assistant message's `stop_reason` is non-null.  Best signal:
    // if the root id is NOT in the streaming-set AND no own tool is
    // in the running set, AND we have at least one assistant message
    // for the thread, it's done.  We approximate by:
    //   - thread is "closing observed" when state.streamingMessageId
    //     does NOT equal this thread's rootId AND no ownToolUseId is
    //     in state.runningToolUseIds.
    // (This matches the parent-turn `result` freeze too.)
    const stillStreaming =
      state.streamingMessageId === thread.rootId ||
      ownToolUseIds.some((id) => state.runningToolUseIds.has(id));
    const closingObserved = !stillStreaming;

    const subState = deriveSubagentState(
      state,
      ownToolUseIds,
      closingObserved,
    );

    // Compute nested running count — direct & deeper descendants of
    // this thread that themselves are still running.
    let nestedRunningCount = 0;
    for (const t of thread.messages) {
      if (t.role !== "assistant") continue;
      for (const block of t.blocks) {
        if (isToolUseBlock(block) && isTaskTool(block.name)) {
          // Each nested Task call contributes its own running set.
          const nested = selectSubagentsForTool(state, block.id);
          for (const nrow of nested) {
            if (nrow.state !== "done") nestedRunningCount += 1;
            nestedRunningCount += nrow.nestedRunningCount;
          }
        }
      }
    }

    // doneAt: best-effort timestamp.  Use the latest message
    // timestamp in the transcript when state === done.
    let doneAt: number | null = null;
    if (subState === "done") {
      doneAt = transcript.reduce<number>((max, m) => {
        const ts = m.timestamp ?? 0;
        return ts > max ? ts : max;
      }, 0) || Date.now();
    }

    // lastReply: most recent text block across the WHOLE transcript
    // (so deeply-nested final replies still surface).
    let lastReply: TextBlockData | null = null;
    for (let i = transcript.length - 1; i >= 0 && !lastReply; i--) {
      const m = transcript[i];
      if (m.role !== "assistant") continue;
      lastReply = latestTextBlock(m.blocks);
    }

    return {
      id: thread.rootId,
      name: nameForSubagent(parentTool, idx),
      state: subState,
      since: thread.messages[0]?.timestamp ?? Date.now(),
      doneAt,
      nestedRunningCount,
      lastReply,
      transcript,
    };
  });

  // Sort by `since` ascending (preserves spawn order).
  rows.sort((a, b) => a.since - b.since);
  return rows;
}

/**
 * Aggregate counts across every subagent in the session, at every
 * nesting depth.  Drives the masthead chip.
 *
 * Counts what the operator sees:
 *   - Every `Task` / `agent` / `agent_dispatch` tool_use block
 *     (these render as `TaskToolBlock` compact rows)
 *   - PLUS any streaming subagents nested under them (parent
 *     dispatched fan-out children with `parent_tool_use_id`)
 *
 * `running` = no tool_result for this block yet (it's in-flight).
 * `done`    = a tool_result has arrived for this block.
 *
 * This pairs 1:1 with the visible `SUBAGENT` rows in the
 * conversation, so the chip's count never disagrees with the eye.
 */
export function selectSubagentCounts(
  state: AgentSessionState,
): SubagentCounts {
  let running = 0;
  let done = 0;
  let totalEverSpawned = 0;
  const seen = new Set<string>();

  function visitTaskBlock(toolUseId: string) {
    if (seen.has(toolUseId)) return;
    seen.add(toolUseId);
    totalEverSpawned += 1;
    if (state.toolResults.has(toolUseId)) done += 1;
    else running += 1;
    // Walk any direct-child subagent threads (parent_tool_use_id ===
    // this Task block's id) — those are streaming subagents under
    // this Task that may themselves spawn more Task blocks.
    for (const row of selectSubagentsForTool(state, toolUseId)) {
      for (const m of row.transcript) {
        if (m.role !== "assistant") continue;
        for (const block of m.blocks) {
          if (isToolUseBlock(block) && isTaskTool(block.name)) {
            visitTaskBlock(block.id);
          }
        }
      }
    }
  }

  // Start from every top-level Task tool_use in the main conversation
  // (messages WITHOUT a parentToolUseId).
  for (const m of state.messages) {
    if (m.parentToolUseId) continue;
    if (m.role !== "assistant") continue;
    for (const block of m.blocks) {
      if (isToolUseBlock(block) && isTaskTool(block.name)) {
        visitTaskBlock(block.id);
      }
    }
  }

  return { running, done, totalEverSpawned };
}
