/**
 * Tests for `selectWorkingState` — the pure selector that drives the
 * Footline + Margin Draft surfaces.
 *
 * Design: `docs/design/agent-working-experience.html`.
 *
 * Coverage targets every verb branch + the margin-draft sourcing
 * priorities (drafting text > thinking > committed snippet).
 */
import { describe, it, expect } from "vitest";
import {
  emptyState,
  type AgentSessionState,
  type RenderedMessage,
} from "../agent/messageStore";
import { selectWorkingState } from "../agent/workingState";
import type {
  ContentBlock,
  TextBlockData,
  ThinkingBlockData,
  ToolUseBlockData,
} from "../agent/types";

/* ─── Fixtures ──────────────────────────────────────────────────────── */

const text = (s: string): TextBlockData => ({ type: "text", text: s });
const thinking = (s: string): ThinkingBlockData => ({
  type: "thinking",
  thinking: s,
});
const tool = (
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): ToolUseBlockData => ({
  type: "tool_use",
  id,
  name,
  input,
});

const userMsg = (
  id: string,
  ts: number,
  parent: string | null = null,
): RenderedMessage => ({
  id,
  role: "user",
  blocks: [text("hi")],
  timestamp: ts,
  parentToolUseId: parent,
});

const asstMsg = (
  id: string,
  ts: number,
  blocks: ContentBlock[],
  parent: string | null = null,
): RenderedMessage => ({
  id,
  role: "assistant",
  blocks,
  timestamp: ts,
  parentToolUseId: parent,
});

const stateWith = (overrides: Partial<AgentSessionState>): AgentSessionState => ({
  ...emptyState(),
  ...overrides,
});

/* ─── Idle / awaiting / pre-stream ─────────────────────────────────── */

describe("selectWorkingState — idle states", () => {
  it("returns idle on an empty session", () => {
    const w = selectWorkingState(emptyState());
    expect(w.active).toBe(false);
    expect(w.verb).toBe("idle");
    expect(w.marginDraftLines).toEqual([]);
    expect(w.runningTool).toBeNull();
  });

  it("returns idle when the last message is an assistant reply and nothing is in flight", () => {
    const state = stateWith({
      messages: [userMsg("u1", 100), asstMsg("a1", 200, [text("done")])],
    });
    expect(selectWorkingState(state).verb).toBe("idle");
  });

  it("returns awaiting when the last message is a user turn with no result yet", () => {
    const state = stateWith({
      messages: [userMsg("u1", 100)],
    });
    const w = selectWorkingState(state);
    expect(w.active).toBe(true);
    expect(w.verb).toBe("awaiting");
    expect(w.object.descriptor).toBe("first byte");
    expect(w.since).toBe(100);
  });

  it("flips back to idle when a result has already landed after the user turn (Stop pre-stream)", () => {
    const state = stateWith({
      messages: [userMsg("u1", 100)],
      resultEventAt: 150,
    });
    expect(selectWorkingState(state).verb).toBe("idle");
  });
});

/* ─── Streaming text vs thinking ───────────────────────────────────── */

describe("selectWorkingState — thinking & drafting", () => {
  it("returns thinking when the streaming message has no text block yet", () => {
    const state = stateWith({
      messages: [
        userMsg("u1", 100),
        asstMsg("a1", 200, [thinking("computing the next step …")]),
      ],
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("thinking");
    expect(w.since).toBe(200);
  });

  it("returns drafting when the streaming message has a non-empty text block", () => {
    const state = stateWith({
      messages: [
        userMsg("u1", 100),
        asstMsg("a1", 200, [text("Here is the fix:")]),
      ],
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("drafting");
    expect(w.object.descriptor).toMatch(/reply/);
  });

  it("drafting object descriptor includes the approximate token count", () => {
    const longText = "x".repeat(800); // ~200 tokens by the 4-chars-per-token rule
    const state = stateWith({
      messages: [
        userMsg("u1", 100),
        asstMsg("a1", 200, [text(longText)]),
      ],
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.object.descriptor).toMatch(/~200 tokens/);
  });
});

/* ─── Tool verbs ───────────────────────────────────────────────────── */

describe("selectWorkingState — tool verbs", () => {
  it("classifies Read as 'reading' and surfaces the file_path", () => {
    const state = stateWith({
      messages: [
        userMsg("u1", 100),
        asstMsg("a1", 200, [tool("t1", "Read", { file_path: "src/foo.ts" })]),
      ],
      runningToolUseIds: new Set(["t1"]),
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("reading");
    expect(w.object.path).toBe("src/foo.ts");
    expect(w.runningTool?.id).toBe("t1");
  });

  it("classifies Edit + Write as 'writing'", () => {
    const stateEdit = stateWith({
      messages: [
        asstMsg("a1", 200, [tool("t1", "Edit", { file_path: "src/foo.ts" })]),
      ],
      runningToolUseIds: new Set(["t1"]),
      streamingMessageId: "a1",
    });
    expect(selectWorkingState(stateEdit).verb).toBe("writing");

    const stateWrite = stateWith({
      messages: [
        asstMsg("a2", 200, [tool("t2", "Write", { file_path: "src/bar.ts" })]),
      ],
      runningToolUseIds: new Set(["t2"]),
      streamingMessageId: "a2",
    });
    expect(selectWorkingState(stateWrite).verb).toBe("writing");
  });

  it("classifies Bash as 'running' and surfaces the command", () => {
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [tool("t1", "Bash", { command: "npm test" })]),
      ],
      runningToolUseIds: new Set(["t1"]),
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("running");
    expect(w.object.command).toBe("npm test");
  });

  it("classifies Grep + Glob as 'searching'", () => {
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [tool("t1", "Grep", { pattern: "foo" })]),
      ],
      runningToolUseIds: new Set(["t1"]),
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("searching");
    expect(w.object.pattern).toBe("foo");
  });

  it("classifies WebFetch as 'fetching'", () => {
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [tool("t1", "WebFetch", { url: "https://example.com" })]),
      ],
      runningToolUseIds: new Set(["t1"]),
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("fetching");
    expect(w.object.url).toBe("https://example.com");
  });

  it("classifies Task / agent / agent_dispatch as 'coordinating' with subagent counts", () => {
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [tool("t1", "agent", { description: "audit" })]),
      ],
      runningToolUseIds: new Set(["t1"]),
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("coordinating");
    expect(w.object.subagents).toBeTruthy();
    expect(w.object.subagents?.totalEverSpawned).toBe(1);
    expect(w.object.subagents?.running).toBe(1);
  });

  it("falls through to 'running' with the tool name for unknown tools", () => {
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [tool("t1", "MysteryTool", { foo: "bar" })]),
      ],
      runningToolUseIds: new Set(["t1"]),
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("running");
    expect(w.object.raw).toBe("MysteryTool");
  });

  it("is case + separator insensitive for tool names", () => {
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [tool("t1", "notebook_edit", { file_path: "x.ipynb" })]),
      ],
      runningToolUseIds: new Set(["t1"]),
      streamingMessageId: "a1",
    });
    expect(selectWorkingState(state).verb).toBe("writing");
  });
});

/* ─── Margin draft sourcing ────────────────────────────────────────── */

describe("selectWorkingState — margin draft lines", () => {
  it("drafting state surfaces the last two sentences of the streaming text", () => {
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [
          text(
            "I will look at the reducer first. Then I will check the renderer. " +
            "Finally I will write a regression test.",
          ),
        ]),
      ],
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("drafting");
    expect(w.marginDraftLines.length).toBe(2);
    expect(w.marginDraftLines[0]).toMatch(/check the renderer/);
    expect(w.marginDraftLines[1]).toMatch(/regression test/);
  });

  it("thinking state pulls from the live thinking text accumulator when block.thinking is empty", () => {
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [thinking("")]),
      ],
      streamingMessageId: "a1",
      streamingThinkingText: new Map([
        ["a1:0", "Considering whether to read the file or grep first."],
      ]),
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("thinking");
    expect(w.marginDraftLines.length).toBeGreaterThan(0);
    expect(w.marginDraftLines[0]).toMatch(/Considering whether/);
  });

  it("running state pulls margin lines from the latest text/thinking snippet", () => {
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [
          text("I'll start by mapping messageStore. Then I'll grep for usages."),
          tool("t1", "Read", { file_path: "src/agent/messageStore.ts" }),
        ]),
      ],
      runningToolUseIds: new Set(["t1"]),
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("reading");
    expect(w.marginDraftLines.length).toBe(2);
    expect(w.marginDraftLines[1]).toMatch(/grep for usages/);
  });

  it("idle session returns no margin lines", () => {
    const w1 = selectWorkingState(emptyState());
    expect(w1.marginDraftLines).toEqual([]);
  });

  it("awaiting state falls back to the user's prompt as Margin Draft context", () => {
    // Custom user message with real text — `userMsg()` helper uses
    // a generic "hi" placeholder which would be filtered anyway.
    const state = stateWith({
      messages: [
        {
          id: "u1",
          role: "user",
          blocks: [text("Refactor the auth module to use JWT.")],
          timestamp: 100,
          parentToolUseId: null,
        },
      ],
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("awaiting");
    expect(w.marginDraftLines.length).toBe(1);
    // Fallback line is wrapped with the sentinel prefix so MarginDraft
    // can split + style the label distinctly from the body.
    expect(w.marginDraftLines[0]).toMatch(/\[responding to\]/);
    expect(w.marginDraftLines[0]).toMatch(/Refactor the auth module/);
  });

  it("thinking state with no narration falls back to the user prompt", () => {
    const state = stateWith({
      messages: [
        {
          id: "u1",
          role: "user",
          blocks: [text("Audit the subagent visibility wiring.")],
          timestamp: 100,
          parentToolUseId: null,
        },
        asstMsg("a1", 200, [thinking("")]), // empty thinking block
      ],
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("thinking");
    expect(w.marginDraftLines.length).toBe(1);
    expect(w.marginDraftLines[0]).toMatch(/Audit the subagent/);
  });

  it("long preview lines are truncated to ~140 chars", () => {
    const longSentence = "a".repeat(500) + ".";
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [text(longSentence)]),
      ],
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.marginDraftLines[0]?.length).toBeLessThanOrEqual(140);
    expect(w.marginDraftLines[0]?.endsWith("…")).toBe(true);
  });

  it("surfaces streaming thinking text BEFORE the consolidated assistant event lands", () => {
    // Real-world race: the SDK emits `thinking_delta` partials and
    // populates `streamingThinkingText` for a while before the first
    // consolidated `assistant` event arrives.  During that window
    // `streamingMessageId` is null and no message exists in
    // `state.messages`, but the operator must still see the reasoning
    // — the Footline should read "thinking" and the Margin Draft
    // should preview the streaming text rather than fall back to the
    // user prompt.
    const state = stateWith({
      messages: [
        {
          id: "u1",
          role: "user",
          blocks: [text("Audit the subagent visibility wiring.")],
          timestamp: 100,
          parentToolUseId: null,
        },
        // No assistant message yet — only partials in the accumulator.
      ],
      streamingMessageId: null,
      streamingThinkingText: new Map([
        ["msg-pending:0", "Walking the reducer to find the dispatch path."],
      ]),
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("thinking");
    expect(w.active).toBe(true);
    expect(w.marginDraftLines.length).toBeGreaterThan(0);
    expect(w.marginDraftLines[0]).toMatch(/Walking the reducer/);
  });

  it("falls back to ANY streaming thinking key when the exact messageId:index doesn't match", () => {
    // Defensive: if the consolidated `assistant` event's message.id
    // differs from the `message_start` id (mismatched stream
    // generations, etc.), the exact-key lookup misses, but the
    // operator still wants to see the reasoning.
    const state = stateWith({
      messages: [
        asstMsg("a-real-id", 200, [thinking("")]),
      ],
      streamingMessageId: "a-real-id",
      streamingThinkingText: new Map([
        ["different-id:0", "Mapping the auth boundaries first."],
      ]),
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("thinking");
    expect(w.marginDraftLines[0]).toMatch(/Mapping the auth boundaries/);
  });
});

/* ─── Tooling priority + transitions ──────────────────────────────── */

describe("selectWorkingState — priority + transitions", () => {
  it("running tool wins over streaming text", () => {
    // Streaming message exists AND a tool is running.  The Footline
    // should describe the tool, not the prose.
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [
          text("Reading the file now…"),
          tool("t1", "Read", { file_path: "src/foo.ts" }),
        ]),
      ],
      runningToolUseIds: new Set(["t1"]),
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("reading");
    expect(w.object.path).toBe("src/foo.ts");
  });

  it("once the tool result lands and the message keeps streaming, verb flips to drafting", () => {
    const state = stateWith({
      messages: [
        asstMsg("a1", 200, [
          text("Done reading; here is what I found:"),
          tool("t1", "Read", { file_path: "src/foo.ts" }),
        ]),
      ],
      runningToolUseIds: new Set(), // no longer running
      streamingMessageId: "a1",
    });
    const w = selectWorkingState(state);
    expect(w.verb).toBe("drafting");
  });
});
