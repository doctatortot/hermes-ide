/**
 * Tests for the subagent selectors.
 *
 * These exercise the pure data path — given a synthesized
 * `AgentSessionState`, the selectors must compute the correct rows,
 * state transitions, nested counts, and aggregate totals.
 *
 * See `docs/superpowers/specs/2026-05-12-subagent-visibility-design.md`.
 */
import { describe, it, expect } from "vitest";
import { emptyState, type AgentSessionState, type RenderedMessage } from "../agent/messageStore";
import {
  selectSubagentsForTool,
  selectSubagentCounts,
  isTaskTool,
} from "../agent/subagentSelectors";
import type { ContentBlock, TextBlockData, ToolUseBlockData } from "../agent/types";

/* ─── Tiny fixtures ─────────────────────────────────────────────── */

const text = (s: string): TextBlockData => ({ type: "text", text: s });

const taskTool = (id: string, description: string): ToolUseBlockData => ({
  type: "tool_use",
  id,
  name: "Task",
  input: { description },
});

const bashTool = (id: string): ToolUseBlockData => ({
  type: "tool_use",
  id,
  name: "Bash",
  input: { command: "echo hi" },
});

const assistantMessage = (
  id: string,
  ts: number,
  blocks: ContentBlock[],
  parentToolUseId: string | null = null,
): RenderedMessage => ({
  id,
  role: "assistant",
  blocks,
  timestamp: ts,
  parentToolUseId,
});

const userMessage = (
  id: string,
  ts: number,
  parentToolUseId: string | null = null,
): RenderedMessage => ({
  id,
  role: "user",
  blocks: [text("hi")],
  timestamp: ts,
  parentToolUseId,
});

const stateWith = (
  overrides: Partial<AgentSessionState>,
): AgentSessionState => ({
  ...emptyState(),
  ...overrides,
});

/* ─── isTaskTool ────────────────────────────────────────────────── */

describe("isTaskTool", () => {
  it("matches Task, TASK, task case-insensitively", () => {
    expect(isTaskTool("Task")).toBe(true);
    expect(isTaskTool("TASK")).toBe(true);
    expect(isTaskTool("task")).toBe(true);
    expect(isTaskTool(" task ")).toBe(true);
  });
  it("does not match other tool names", () => {
    expect(isTaskTool("Bash")).toBe(false);
    expect(isTaskTool("TaskRunner")).toBe(false);
    expect(isTaskTool("")).toBe(false);
  });
});

/* ─── selectSubagentsForTool ────────────────────────────────────── */

describe("selectSubagentsForTool", () => {
  it("returns an empty array when no messages reference the toolUseId", () => {
    const state = stateWith({
      messages: [
        assistantMessage("u1", 100, [text("just a prompt")]),
      ],
    });
    expect(selectSubagentsForTool(state, "task-1")).toEqual([]);
  });

  it("returns one row per distinct subagent assistant root id, ordered by since", () => {
    const state = stateWith({
      messages: [
        // Parent assistant message with a Task tool_use call
        assistantMessage("a-parent", 100, [taskTool("task-1", "Audit main")]),
        // Subagent A — born at t=110
        assistantMessage("sa-A", 110, [text("Working on audit-main")], "task-1"),
        // Subagent B — born at t=120
        assistantMessage("sa-B", 120, [text("Working on audit-fix")], "task-1"),
        // Subagent A continuation — same root id
        assistantMessage("sa-A", 130, [text("Done with main")], "task-1"),
      ],
    });
    const rows = selectSubagentsForTool(state, "task-1");
    expect(rows.map((r) => r.id)).toEqual(["sa-A", "sa-B"]);
    expect(rows[0].since).toBe(110);
    expect(rows[1].since).toBe(120);
  });

  it("derives state = running when a subagent's tool_use is in runningToolUseIds", () => {
    const state = stateWith({
      messages: [
        assistantMessage("a-parent", 100, [taskTool("task-1", "Foo")]),
        assistantMessage(
          "sa-A",
          110,
          [bashTool("bash-1")],
          "task-1",
        ),
      ],
      runningToolUseIds: new Set(["bash-1"]),
      streamingMessageId: "sa-A",
    });
    const [row] = selectSubagentsForTool(state, "task-1");
    expect(row.state).toBe("running");
  });

  it("derives state = thinking when subagent is streaming but has no running tool", () => {
    const state = stateWith({
      messages: [
        assistantMessage("a-parent", 100, [taskTool("task-1", "Foo")]),
        assistantMessage("sa-A", 110, [text("Considering options…")], "task-1"),
      ],
      runningToolUseIds: new Set(),
      streamingMessageId: "sa-A",
    });
    const [row] = selectSubagentsForTool(state, "task-1");
    expect(row.state).toBe("thinking");
  });

  it("derives state = done when neither streaming nor any tool is running", () => {
    const state = stateWith({
      messages: [
        assistantMessage("a-parent", 100, [taskTool("task-1", "Foo")]),
        assistantMessage("sa-A", 110, [text("Final answer")], "task-1"),
      ],
      runningToolUseIds: new Set(),
      streamingMessageId: null,
    });
    const [row] = selectSubagentsForTool(state, "task-1");
    expect(row.state).toBe("done");
    expect(row.doneAt).not.toBeNull();
  });

  it("uses the Task description for the row name", () => {
    const state = stateWith({
      messages: [
        assistantMessage("a-parent", 100, [taskTool("task-1", "Audit the four worktrees")]),
        assistantMessage("sa-A", 110, [text("Working")], "task-1"),
      ],
    });
    const [row] = selectSubagentsForTool(state, "task-1");
    expect(row.name).toBe("Audit the four worktrees");
  });

  it("falls back to `subagent #N` when there is no description", () => {
    const state = stateWith({
      messages: [
        assistantMessage("a-parent", 100, [
          { type: "tool_use", id: "task-1", name: "Task", input: {} },
        ]),
        assistantMessage("sa-A", 110, [text("hi")], "task-1"),
      ],
    });
    const [row] = selectSubagentsForTool(state, "task-1");
    expect(row.name).toBe("subagent #1");
  });

  it("lastReply returns the most recent assistant text block", () => {
    const state = stateWith({
      messages: [
        assistantMessage("a-parent", 100, [taskTool("task-1", "Foo")]),
        assistantMessage(
          "sa-A",
          110,
          [text("Hello"), text("World"), bashTool("bash-1")],
          "task-1",
        ),
      ],
    });
    const [row] = selectSubagentsForTool(state, "task-1");
    expect(row.lastReply?.text).toBe("World");
  });

  it("lastReply is null when the subagent never spoke", () => {
    const state = stateWith({
      messages: [
        assistantMessage("a-parent", 100, [taskTool("task-1", "Foo")]),
        // user-only event with no assistant message
        userMessage("u-1", 110, "task-1"),
      ],
    });
    const [row] = selectSubagentsForTool(state, "task-1");
    expect(row.lastReply).toBeNull();
  });

  it("counts nested running subagents via nestedRunningCount", () => {
    const state = stateWith({
      messages: [
        // Top-level Task
        assistantMessage("a-parent", 100, [taskTool("task-1", "Outer")]),
        // Subagent A — itself calls Task("Inner")
        assistantMessage(
          "sa-A",
          110,
          [taskTool("task-2", "Inner")],
          "task-1",
        ),
        // Inner subagent — running
        assistantMessage(
          "sa-inner",
          120,
          [bashTool("bash-inner")],
          "task-2",
        ),
      ],
      runningToolUseIds: new Set(["bash-inner"]),
      streamingMessageId: "sa-inner",
    });
    const [row] = selectSubagentsForTool(state, "task-1");
    expect(row.nestedRunningCount).toBe(1);
  });
});

/* ─── selectSubagentCounts ──────────────────────────────────────── */

describe("selectSubagentCounts", () => {
  // The chip MUST agree with the eye: it counts visible Task /
  // agent tool_use blocks.  `running` = no tool_result yet (the
  // Subagent row is in flight).  `done` = tool_result observed.

  it("returns zeros on an empty session", () => {
    expect(selectSubagentCounts(emptyState())).toEqual({
      running: 0,
      done: 0,
      totalEverSpawned: 0,
    });
  });

  it("counts a single in-flight Task tool_use as running", () => {
    const state = stateWith({
      messages: [
        assistantMessage("a-parent", 100, [taskTool("task-1", "X")]),
      ],
      // No tool_result for task-1 yet → running.
    });
    const c = selectSubagentCounts(state);
    expect(c.running).toBe(1);
    expect(c.done).toBe(0);
    expect(c.totalEverSpawned).toBe(1);
  });

  it("counts a returned Task tool_use as done", () => {
    const toolResults = new Map();
    toolResults.set("task-1", {
      type: "tool_result",
      tool_use_id: "task-1",
      content: "ok",
    });
    const state = stateWith({
      messages: [
        assistantMessage("a-parent", 100, [taskTool("task-1", "X")]),
      ],
      toolResults,
    });
    const c = selectSubagentCounts(state);
    expect(c.running).toBe(0);
    expect(c.done).toBe(1);
    expect(c.totalEverSpawned).toBe(1);
  });

  it("running + done totals across a multi-Task session", () => {
    // Three Task tool_uses dispatched at once; one already returned.
    const toolResults = new Map();
    toolResults.set("task-1", {
      type: "tool_result",
      tool_use_id: "task-1",
      content: "ok",
    });
    const state = stateWith({
      messages: [
        assistantMessage("a-parent", 100, [
          taskTool("task-1", "audit one"),
          taskTool("task-2", "audit two"),
          taskTool("task-3", "audit three"),
        ]),
      ],
      toolResults,
    });
    const c = selectSubagentCounts(state);
    expect(c.running).toBe(2);
    expect(c.done).toBe(1);
    expect(c.totalEverSpawned).toBe(3);
  });

  it("descends into nested Task calls inside a streaming subagent transcript", () => {
    const state = stateWith({
      messages: [
        // Top-level Task
        assistantMessage("a-parent", 100, [taskTool("task-outer", "outer")]),
        // Streaming subagent that itself calls Task
        assistantMessage(
          "sa-A",
          110,
          [taskTool("task-inner", "inner")],
          "task-outer",
        ),
      ],
    });
    const c = selectSubagentCounts(state);
    // Both Task tool_uses are in flight (no tool_results), so both
    // count as running and totalEverSpawned = 2.
    expect(c.running).toBe(2);
    expect(c.done).toBe(0);
    expect(c.totalEverSpawned).toBe(2);
  });
});
