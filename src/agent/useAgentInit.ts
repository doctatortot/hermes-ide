/**
 * Lightweight hook that snapshots the most-recent `system/init` event for an
 * agent session.
 *
 * The composer needs `init.slash_commands`, `init.model`, and
 * `init.permissionMode` to populate its pickers.  Subscribing here (rather
 * than through the full `messageStore` reducer) keeps the composer's
 * footprint small and avoids racing with the renderer's own reducer:
 * `agent-event-{sessionId}` is broadcast by Tauri, so multiple listeners
 * each receive their own copy without sharing mutable state.
 *
 * NOT a hook factory — exported directly so callers just write
 *   const init = useAgentInit(sessionId);
 *
 * Returns `null` until the first `init` event arrives, or whenever the
 * session id is null/empty.
 *
 * Bug 5 (1.2.x): a module-level cache makes init data survive
 * component remounts and late subscribers.  Tauri event channels do
 * NOT replay past events when a new listener attaches, so without this
 * cache the composer's chips (model / permission / effort) would
 * vanish after any session switch — they're conditional on
 * `init?.model`, and `init` was reset to null on every sessionId
 * change.  The cache catches the FIRST init emit per session and
 * makes it available to anyone who subscribes later.
 */

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEvent, InitEvent } from "./types";
import { isInitEvent, isStateChangedEvent } from "./types";

// Module-level cache.  Keyed by sessionId.  Survives component
// unmount / remount because it lives outside React.  Sized by the
// number of agent sessions the user has actively touched — bounded
// in practice by how many tabs they have open.
//
// Writers: the listener inside `useAgentInit` itself (every event it
// processes also updates the cache), AND the live subscription in
// SessionContext's `attachInitListener` (via `cacheAgentInit` below)
// so that the very first init event reaches the cache even before any
// composer has mounted.
//
// Readers: `useAgentInit` seeds its local state from the cache on
// every mount before waiting for live events.
const latestInitBySession: Map<string, InitEvent> = new Map();

/**
 * Manually upsert a session's init snapshot into the cache.  Called
 * by SessionContext's `attachInitListener` so that the central
 * spawn-time listener also primes the cache — that way the very
 * first late-mounting composer doesn't have to wait for a respawn.
 *
 * Idempotent.  Last write wins.  Exported for external writers
 * only — internal updates flow directly through the local listener.
 */
export function cacheAgentInit(sessionId: string, init: InitEvent): void {
  latestInitBySession.set(sessionId, init);
}

/**
 * Release a session's cached init.  Called when a session is closed
 * for good (in SessionContext's session-removed handler).  Prevents
 * the cache from growing unbounded across long-running app sessions.
 */
export function clearAgentInitCache(sessionId: string): void {
  latestInitBySession.delete(sessionId);
}

/** Internal: read the cache.  Visible for unit tests via the export. */
export function peekAgentInitCache(sessionId: string): InitEvent | null {
  return latestInitBySession.get(sessionId) ?? null;
}

/** Pure reducer step — exported for unit testing.
 *
 *  Two events feed this reducer:
 *
 *    1. `system/init` (fresh from the SDK on spawn / resume) — wholly
 *       replaces the cached init.
 *    2. `_hermes_state_changed` (bridge-internal) — patches the cached
 *       init's `model` / `permissionMode` fields when Claude's runtime
 *       values drift mid-session (e.g. EnterPlanMode flips the mode
 *       without a respawn).  Ignored when no init has been seen yet —
 *       we don't want to fabricate an init from a partial state.
 */
export function reduceInit(prev: InitEvent | null, event: AgentEvent): InitEvent | null {
  if (isInitEvent(event)) return event;
  if (isStateChangedEvent(event)) {
    if (!prev) return prev;
    const next = { ...prev };
    if (typeof event.model === "string") next.model = event.model;
    if (typeof event.permissionMode === "string") {
      next.permissionMode = event.permissionMode;
    }
    return next;
  }
  return prev;
}

export function useAgentInit(sessionId: string | null | undefined): InitEvent | null {
  // Seed from the module-level cache on every mount / sessionId
  // change.  This is the Bug 5 fix: without it, switching between
  // sessions wipes the chips because the init event was emitted
  // ONCE at spawn time and Tauri doesn't replay to late subscribers.
  //
  // useState's lazy initializer keeps the cache read out of the
  // render path on subsequent renders — only fires on mount (or on
  // sessionId change via the useEffect below).
  const [init, setInit] = useState<InitEvent | null>(() =>
    sessionId ? latestInitBySession.get(sessionId) ?? null : null,
  );

  useEffect(() => {
    // Re-seed when sessionId changes (the lazy initializer only ran
    // once at mount).  Setting to the cached value means "don't blank
    // the chips if we have data for this session id".
    setInit(sessionId ? latestInitBySession.get(sessionId) ?? null : null);
    if (!sessionId) return;
    let cancelled = false;
    let un: UnlistenFn | undefined;

    listen<AgentEvent>(`agent-event-${sessionId}`, (msg) => {
      const ev = msg.payload;
      // Funnel both event kinds through the pure reducer so the
      // patch-on-state-changed semantics are testable.
      setInit((prev) => {
        const next = reduceInit(prev, ev);
        // Mirror writes into the module-level cache so other
        // mounts/components see them.  Only stash full InitEvent
        // snapshots — state-changed patches piggyback on the
        // previous-init in the reducer, so the cache already has the
        // right base when `next === prev` would otherwise.
        if (next && next !== prev) {
          latestInitBySession.set(sessionId, next);
        }
        return next;
      });
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        un = u;
      }
    });

    return () => {
      cancelled = true;
      un?.();
    };
  }, [sessionId]);

  return init;
}
