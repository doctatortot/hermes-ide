// @vitest-environment jsdom
/**
 * Component tests for `WorkingFootline` and `MarginDraft`.
 *
 * Both surfaces are pure (props in, JSX out) — the working-state
 * selector is unit-tested separately.  These tests verify rendering,
 * the stop affordance, and the empty-state contract.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { WorkingFootline } from "../agent/WorkingFootline";
import { MarginDraft } from "../agent/MarginDraft";
import {
  MARGIN_DRAFT_FALLBACK_PREFIX,
  type WorkingState,
} from "../agent/workingState";

afterEach(() => cleanup());

const idle: WorkingState = {
  active: false,
  verb: "idle",
  object: {},
  since: null,
  cumulativeOutputTokens: 0,
  marginDraftLines: [],
  runningTool: null,
};

/* ─── WorkingFootline ──────────────────────────────────────────────── */

describe("WorkingFootline", () => {
  it("renders nothing when state is idle", () => {
    const { container } = render(<WorkingFootline state={idle} />);
    expect(container.querySelector(".agent-footline")).toBeNull();
  });

  it("renders the verb + path for a 'reading' state", () => {
    const state: WorkingState = {
      active: true,
      verb: "reading",
      object: { path: "src/agent/messageStore.ts" },
      since: Date.now() - 11_000,
      cumulativeOutputTokens: 412,
      marginDraftLines: [],
      runningTool: { id: "t1", name: "Read", input: {} },
    };
    render(<WorkingFootline state={state} />);
    expect(screen.getByText("reading")).toBeInTheDocument();
    expect(screen.getByText("src/agent/messageStore.ts")).toBeInTheDocument();
    expect(screen.getByText(/412 tok/)).toBeInTheDocument();
  });

  it("renders the verb + command for a 'running' Bash state", () => {
    const state: WorkingState = {
      active: true,
      verb: "running",
      object: { command: "grep -rn parent_tool_use_id src/" },
      since: Date.now() - 24_000,
      cumulativeOutputTokens: 684,
      marginDraftLines: [],
      runningTool: { id: "t1", name: "Bash", input: {} },
    };
    render(<WorkingFootline state={state} />);
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText(/grep -rn/)).toBeInTheDocument();
  });

  it("hides the object for the 'thinking' state (verb alone is enough)", () => {
    const state: WorkingState = {
      active: true,
      verb: "thinking",
      object: {},
      since: Date.now() - 7_000,
      cumulativeOutputTokens: 312,
      marginDraftLines: [],
      runningTool: null,
    };
    render(<WorkingFootline state={state} />);
    expect(screen.getByText("thinking")).toBeInTheDocument();
    expect(document.querySelector(".agent-footline-object")).toBeNull();
  });

  it("surfaces subagent counts for 'coordinating'", () => {
    const state: WorkingState = {
      active: true,
      verb: "coordinating",
      object: {
        subagents: { running: 2, done: 1, totalEverSpawned: 3 },
      },
      since: Date.now() - 18_000,
      cumulativeOutputTokens: 2100,
      marginDraftLines: [],
      runningTool: { id: "t1", name: "agent", input: {} },
    };
    render(<WorkingFootline state={state} />);
    expect(screen.getByText(/2 of 3 subagents/)).toBeInTheDocument();
    expect(screen.getByText(/1 done/)).toBeInTheDocument();
  });

  it("shows 'first byte' for the awaiting state", () => {
    const state: WorkingState = {
      active: true,
      verb: "awaiting",
      object: { descriptor: "first byte" },
      since: Date.now() - 1_000,
      cumulativeOutputTokens: 0,
      marginDraftLines: [],
      runningTool: null,
    };
    render(<WorkingFootline state={state} />);
    expect(screen.getByText("awaiting")).toBeInTheDocument();
    expect(screen.getByText(/first byte/)).toBeInTheDocument();
  });

  it("escalates awaiting copy after 5+ seconds (negotiating with API)", () => {
    const state: WorkingState = {
      active: true,
      verb: "awaiting",
      object: { descriptor: "first byte" },
      since: Date.now() - 8_000, // > 5s
      cumulativeOutputTokens: 0,
      marginDraftLines: [],
      runningTool: null,
    };
    render(<WorkingFootline state={state} />);
    expect(screen.getByText(/negotiating with the API/)).toBeInTheDocument();
  });

  it("escalates awaiting copy after 15+ seconds (long context)", () => {
    const state: WorkingState = {
      active: true,
      verb: "awaiting",
      object: { descriptor: "first byte" },
      since: Date.now() - 20_000, // > 15s
      cumulativeOutputTokens: 0,
      marginDraftLines: [],
      runningTool: null,
    };
    render(<WorkingFootline state={state} />);
    expect(screen.getByText(/long context/)).toBeInTheDocument();
  });

  it("escalates awaiting copy after 45+ seconds (still alive)", () => {
    const state: WorkingState = {
      active: true,
      verb: "awaiting",
      object: { descriptor: "first byte" },
      since: Date.now() - 50_000, // > 45s
      cumulativeOutputTokens: 0,
      marginDraftLines: [],
      runningTool: null,
    };
    render(<WorkingFootline state={state} />);
    expect(screen.getByText(/still alive/)).toBeInTheDocument();
  });

  it("calls onStop when the Stop button is clicked", () => {
    const onStop = vi.fn();
    const state: WorkingState = {
      active: true,
      verb: "drafting",
      object: { descriptor: "reply · ~620 tokens" },
      since: Date.now() - 38_000,
      cumulativeOutputTokens: 1200,
      marginDraftLines: [],
      runningTool: null,
    };
    render(<WorkingFootline state={state} onStop={onStop} />);
    fireEvent.click(screen.getByLabelText("Stop the current turn"));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("calls onStop when Esc is pressed and focus is outside an input", () => {
    const onStop = vi.fn();
    const state: WorkingState = {
      active: true,
      verb: "thinking",
      object: {},
      since: Date.now() - 3_000,
      cumulativeOutputTokens: 100,
      marginDraftLines: [],
      runningTool: null,
    };
    render(<WorkingFootline state={state} onStop={onStop} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onStop when Esc fires from inside a textarea (the composer keeps the key)", () => {
    const onStop = vi.fn();
    const state: WorkingState = {
      active: true,
      verb: "thinking",
      object: {},
      since: Date.now() - 3_000,
      cumulativeOutputTokens: 100,
      marginDraftLines: [],
      runningTool: null,
    };
    document.body.innerHTML = "<textarea></textarea>";
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    ta.focus();
    render(<WorkingFootline state={state} onStop={onStop} />);
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("renders a 'stopping' variant when verb === 'stopping'", () => {
    const state: WorkingState = {
      active: true,
      verb: "stopping",
      object: { descriptor: "flushing partial output…" },
      since: Date.now() - 11_000,
      cumulativeOutputTokens: 412,
      marginDraftLines: [],
      runningTool: null,
    };
    const { container } = render(<WorkingFootline state={state} />);
    const fl = container.querySelector(".agent-footline");
    expect(fl).not.toBeNull();
    expect(fl!.getAttribute("data-variant")).toBe("stopping");
  });
});

/* ─── MarginDraft ──────────────────────────────────────────────────── */

describe("MarginDraft", () => {
  it("renders nothing on an idle state", () => {
    const { container } = render(<MarginDraft state={idle} />);
    expect(container.querySelector(".agent-margin-draft")).toBeNull();
  });

  it("renders nothing when active but lines are empty", () => {
    const state: WorkingState = {
      ...idle,
      active: true,
      verb: "awaiting",
      marginDraftLines: [],
    };
    const { container } = render(<MarginDraft state={state} />);
    expect(container.querySelector(".agent-margin-draft")).toBeNull();
  });

  it("renders up to two lines, marking the LAST one as fresh", () => {
    const state: WorkingState = {
      ...idle,
      active: true,
      verb: "drafting",
      marginDraftLines: [
        "Reading the reducer first.",
        "Then I'll grep for usages.",
      ],
    };
    render(<MarginDraft state={state} />);
    const lines = document.querySelectorAll(".agent-margin-draft-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].classList.contains("fresh")).toBe(false);
    expect(lines[1].classList.contains("fresh")).toBe(true);
    expect(lines[0].textContent).toBe("Reading the reducer first.");
    expect(lines[1].textContent).toBe("Then I'll grep for usages.");
  });

  it("renders a single line as fresh when only one is available", () => {
    const state: WorkingState = {
      ...idle,
      active: true,
      verb: "thinking",
      marginDraftLines: ["Considering whether to read or grep first."],
    };
    render(<MarginDraft state={state} />);
    const lines = document.querySelectorAll(".agent-margin-draft-line");
    expect(lines).toHaveLength(1);
    expect(lines[0].classList.contains("fresh")).toBe(true);
  });

  it("splits the fallback sentinel into a styled prefix + body", () => {
    const state: WorkingState = {
      ...idle,
      active: true,
      verb: "awaiting",
      marginDraftLines: [
        `${MARGIN_DRAFT_FALLBACK_PREFIX}Refactor the auth module to use JWT.`,
      ],
    };
    render(<MarginDraft state={state} />);
    const prefix = document.querySelector(".agent-margin-draft-prefix");
    const body = document.querySelector(".agent-margin-draft-body");
    expect(prefix).not.toBeNull();
    expect(prefix!.textContent).toBe("responding to");
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe("Refactor the auth module to use JWT.");
  });

  it("does NOT render a prefix for plain narration lines", () => {
    const state: WorkingState = {
      ...idle,
      active: true,
      verb: "drafting",
      marginDraftLines: ["Reading the reducer first."],
    };
    render(<MarginDraft state={state} />);
    const prefix = document.querySelector(".agent-margin-draft-prefix");
    expect(prefix).toBeNull();
    const body = document.querySelector(".agent-margin-draft-body");
    expect(body!.textContent).toBe("Reading the reducer first.");
  });
});
