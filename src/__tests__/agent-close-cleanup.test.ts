/**
 * Regression tests for the agent-mode session close path.
 *
 * Bug 1 (critical, 1.2.x): closing an agent session leaked everything.
 *
 *   Frontend symptom: `closeSession` invoked `close_session` (Tauri) but
 *     never invoked `close_agent_session`, so the Node bridge subprocess
 *     became a zombie on every close.
 *
 *   Backend symptom: `close_session` (pty/commands.rs) gated ALL cleanup
 *     — including worktree removal — on `mgr.sessions.remove(...)`
 *     returning Some. Agent sessions never insert into mgr.sessions, so
 *     `git worktree` rows and on-disk directories leaked.
 *
 * The fix extracts the agent-aware close sequence into the pure helper
 * `performAgentAwareClose` exported from SessionContext. These tests
 * exercise that helper directly so we don't need to render the full
 * React tree.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../terminal/TerminalPool", () => ({
  createTerminal: vi.fn(),
  destroy: vi.fn(),
  updateSettings: vi.fn(),
  writeScrollback: vi.fn(),
  focusTerminal: vi.fn(),
  refitActive: vi.fn(),
}));
vi.mock("../utils/notifications", () => ({
  initNotifications: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
// The export below does not exist yet — Bug 1's fix introduces it.
// Importing it here makes the test fail with a missing-export error
// until the helper is added to src/state/SessionContext.tsx.
import { performAgentAwareClose } from "../state/SessionContext";

describe("Bug 1 — performAgentAwareClose tears down agent + backend in order", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("invokes close_agent_session BEFORE close_session for agent-mode sessions", async () => {
    const order: string[] = [];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      order.push(cmd);
      return Promise.resolve(undefined);
    });

    await performAgentAwareClose("sess-agent", "agent");

    // Both must be called, in this exact order.  Without the
    // close_agent_session call the Node bridge subprocess leaks; without
    // close_session second the backend worktree cleanup never runs.
    expect(order).toEqual(["close_agent_session", "close_session"]);
  });

  it("does NOT call close_agent_session for terminal-mode sessions", async () => {
    const order: string[] = [];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      order.push(cmd);
      return Promise.resolve(undefined);
    });

    await performAgentAwareClose("sess-term", "terminal");

    expect(order).toEqual(["close_session"]);
    expect(order).not.toContain("close_agent_session");
  });

  it("still calls close_session even when close_agent_session rejects (subprocess already dead)", async () => {
    const order: string[] = [];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      order.push(cmd);
      if (cmd === "close_agent_session") {
        return Promise.reject(new Error("Agent session 'sess-agent' not found"));
      }
      return Promise.resolve(undefined);
    });

    await performAgentAwareClose("sess-agent", "agent");

    // The agent call rejected but we must still tear down the backend
    // session so worktrees / DB rows get cleaned up.
    expect(order).toEqual(["close_agent_session", "close_session"]);
  });

  it("passes the session id to both Tauri commands", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      return Promise.resolve(undefined);
    });

    await performAgentAwareClose("the-real-id", "agent");

    expect(calls).toEqual([
      { cmd: "close_agent_session", args: { sessionId: "the-real-id" } },
      { cmd: "close_session", args: { sessionId: "the-real-id" } },
    ]);
  });
});
