// @vitest-environment jsdom
/**
 * Bug 5 regression tests for `useAgentInit`.
 *
 * Symptom (user report, 1.2.x):
 *   The model / permission / effort chips disappear from the composer
 *   after the user switches between agent sessions.  Only the static
 *   composer-footer buttons ("Builder", "Terminal", "Attach") remain.
 *   Sometimes the chips come back after a respawn (model swap, EnterPlanMode,
 *   message-driven re-init), but the steady state for any session that
 *   isn't being actively respawned is "no chips".
 *
 * Root cause:
 *   `useAgentInit` subscribes to `agent-event-{sessionId}` AFTER mount.
 *   But the SDK only emits `system/init` ONCE per spawn — long before the
 *   subscriber attaches.  Tauri event channels don't replay past events
 *   to late subscribers, so the hook stays in its initial `null` state
 *   forever for already-running sessions.  The composer's chip render
 *   condition `(liveModel || pendingModel)` evaluates to false →
 *   nothing renders.
 *
 *   On every `sessionId` change the hook explicitly resets to `null`
 *   (line 55), wiping the previously-captured init even if the user
 *   switches back to the same session a moment later.
 *
 * Fix shape (implemented after these tests fail):
 *   Add a module-level `latestInitBySession: Map<string, InitEvent>` cache
 *   that survives component unmounts.  Any subscriber that catches an
 *   init event writes through to the cache; new subscribers seed their
 *   local state from the cache on mount before waiting for the next
 *   event.  Effectively a per-session "replay" layer for the most
 *   recent init.
 *
 * These tests deliberately mock `@tauri-apps/api/event` so we can drive
 * event delivery deterministically and reproduce the late-subscriber
 * timing that production hits when the user switches sessions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ─── Mock the Tauri event system ─────────────────────────────────────
//
// `listen` returns an unsubscribe; multiple `listen` calls share the
// same channel.  Critically: in our mock (matching real Tauri),
// `emit` only delivers to handlers that are CURRENTLY registered —
// past events are NOT replayed to late subscribers.

interface Listener {
  channel: string;
  handler: (msg: { payload: unknown }) => void;
}
const handlers: Listener[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (channel: string, handler: (msg: { payload: unknown }) => void) => {
    const entry: Listener = { channel, handler };
    handlers.push(entry);
    return () => {
      const idx = handlers.indexOf(entry);
      if (idx >= 0) handlers.splice(idx, 1);
    };
  }),
}));

function emit(channel: string, payload: unknown) {
  // Snapshot first so handlers that unsubscribe during delivery
  // (don't pretend to be paranoid — Tauri does this too) don't shift
  // the array under our iteration.
  const snapshot = handlers.filter((h) => h.channel === channel);
  for (const h of snapshot) h.handler({ payload });
}

beforeEach(() => {
  handlers.length = 0;
});

afterEach(() => {
  handlers.length = 0;
});

import { useAgentInit, cacheAgentInit, clearAgentInitCache } from "../agent/useAgentInit";
import type { InitEvent } from "../agent/types";

// Reset the module-level cache between tests so they're independent.
beforeEach(() => {
  // The cache is keyed by sessionId — we use distinct ids across
  // tests, but clear-as-defense to avoid order-dependent failures.
  clearAgentInitCache("sess-1");
  clearAgentInitCache("sess-A");
  clearAgentInitCache("sess-B");
  clearAgentInitCache("sess-temp");
});

function makeInit(overrides: Partial<InitEvent> = {}): InitEvent {
  return {
    type: "system",
    subtype: "init",
    cwd: "/tmp",
    session_id: "claude-sess-abc",
    uuid: "uuid-1",
    tools: [],
    slash_commands: [],
    mcp_servers: [],
    model: "claude-opus-4-7",
    permissionMode: "default",
    ...overrides,
  };
}

// ─── Sanity check: live subscriber happy path ────────────────────────
// Verifies the mock works the way real Tauri does: live subscribers
// receive future events.  If this fails, the rest of the suite is
// meaningless.
describe("useAgentInit — happy path (live subscriber)", () => {
  it("captures the init event when the listener was mounted before emit", async () => {
    const init = makeInit({ model: "claude-opus-4-7" });
    const { result } = renderHook(() => useAgentInit("sess-1"));

    // Wait a microtask for the listen() promise inside the hook to
    // resolve and the listener to be registered.
    await act(async () => {});

    act(() => emit("agent-event-sess-1", init));
    expect(result.current?.model).toBe("claude-opus-4-7");
  });
});

// ─── The actual bug — late subscriber & remount ──────────────────────
describe("Bug 5 — useAgentInit replays the cached init for late subscribers", () => {
  it("returns the cached init when the listener mounts AFTER the init event was emitted", async () => {
    const init = makeInit({ model: "claude-sonnet-4-6", permissionMode: "plan" });

    // Production timeline:
    //   1. SessionContext's attachInitListener subscribed at session
    //      spawn time, init event fired and the listener wrote into
    //      the module-level cache via `cacheAgentInit(...)`.
    //   2. The composer's useAgentInit didn't exist yet (no React
    //      component had rendered the composer when the agent booted —
    //      e.g. the user was on a different pane).
    //   3. The user finally clicks the session; useAgentInit subscribes
    //      NOW.  Without the cache it would wait forever for an init
    //      that already came and went.
    //
    // We simulate step 1 by calling `cacheAgentInit` directly — that
    // is exactly what SessionContext's listener does in production.
    cacheAgentInit("sess-1", init);

    const { result } = renderHook(() => useAgentInit("sess-1"));
    await act(async () => {});

    expect(
      result.current?.model,
      "the cached init must be available to late subscribers — otherwise the chips never render after a session switch",
    ).toBe("claude-sonnet-4-6");
    expect(result.current?.permissionMode).toBe("plan");
  });

  it("returns the cached init on remount after the listener was previously unmounted", async () => {
    // The user-visible flow:
    //   1. User opens session A; useAgentInit mounts, listens, captures init.
    //   2. User switches to session B; A's hook unmounts.
    //   3. User switches back to A; the hook remounts with the same
    //      sessionId.  Production today: setInit(null) → re-listen →
    //      no replay → null forever.  The chips were there a second
    //      ago and are gone now.
    const init = makeInit({ model: "claude-opus-4-7" });

    const first = renderHook(() => useAgentInit("sess-A"));
    await act(async () => {});
    act(() => emit("agent-event-sess-A", init));
    expect(first.result.current?.model).toBe("claude-opus-4-7");

    // User switches AWAY — the hook unmounts (RTL's unmount calls the
    // useEffect cleanup which unlistens).
    first.unmount();

    // User comes back to session A — fresh mount, same sessionId.
    const second = renderHook(() => useAgentInit("sess-A"));
    await act(async () => {});

    expect(
      second.result.current?.model,
      "after re-mounting for an already-running session, the chip data must be restored from cache",
    ).toBe("claude-opus-4-7");
    second.unmount();
  });

  it("does NOT leak cached state across different session ids", async () => {
    // A regression guard for the fix.  The module-level cache must be
    // keyed by sessionId — session B's init must not bleed into
    // session A's hook when A first mounts on a clean session.
    const initB = makeInit({ session_id: "claude-sess-B", model: "claude-opus-4-7" });

    cacheAgentInit("sess-B", initB);

    // Session A's first viewer arrives.  No init has been cached for
    // A.  The hook must return null — it must NOT inherit B's data.
    const { result } = renderHook(() => useAgentInit("sess-A"));
    await act(async () => {});

    expect(result.current).toBeNull();
  });

  it("does NOT replay a STALE init when the session was respawned with a different uuid", async () => {
    // The cache must store the LATEST init per session, not the first
    // one.  If a respawn happens (e.g. model swap), late subscribers
    // should see the new model — otherwise the chip would silently
    // show stale data.
    const oldInit = makeInit({ uuid: "old-uuid", model: "claude-sonnet-4-6" });
    const newInit = makeInit({ uuid: "new-uuid", model: "claude-opus-4-7" });

    cacheAgentInit("sess-1", oldInit);
    cacheAgentInit("sess-1", newInit);

    const { result } = renderHook(() => useAgentInit("sess-1"));
    await act(async () => {});

    expect(result.current?.model).toBe("claude-opus-4-7");
    expect(result.current?.uuid).toBe("new-uuid");
  });

  it("clears the cache for a session when explicitly torn down (cleanup helper)", async () => {
    // When a session is closed for good, its cache entry must be
    // released to avoid an unbounded map across long-running sessions.
    // `clearAgentInitCache(sessionId)` is exported for close paths
    // to call.
    cacheAgentInit("sess-temp", makeInit({ model: "claude-opus-4-7" }));

    // Verify the cache was populated.
    const before = renderHook(() => useAgentInit("sess-temp"));
    await act(async () => {});
    expect(before.result.current?.model).toBe("claude-opus-4-7");
    before.unmount();

    // Tear down.
    clearAgentInitCache("sess-temp");

    // Late subscriber arrives — cache is gone, no replay possible.
    const after = renderHook(() => useAgentInit("sess-temp"));
    await act(async () => {});
    expect(after.result.current).toBeNull();
    after.unmount();
  });

  it("a live listener that catches an init writes through to the cache for late subscribers", async () => {
    // The composer's own useAgentInit listener is also a writer.  If
    // SessionContext somehow missed the init (e.g. it attached late),
    // the FIRST composer that catches the init must populate the
    // cache so the SECOND composer (after a switch) can read it.
    const first = renderHook(() => useAgentInit("sess-1"));
    await act(async () => {});

    act(() => emit("agent-event-sess-1", makeInit({ model: "claude-opus-4-7" })));
    expect(first.result.current?.model).toBe("claude-opus-4-7");
    first.unmount();

    // Switch back: hook re-mounts for the SAME session id.  Tauri
    // won't replay the init, but the cache must.
    const second = renderHook(() => useAgentInit("sess-1"));
    await act(async () => {});
    expect(second.result.current?.model).toBe("claude-opus-4-7");
    second.unmount();
  });
});
