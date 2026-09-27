/**
 * TodoPanel — sticky checklist pinned to the bottom of the conversation
 * column.  Visual: §8.6.
 *
 * Driven by the latest TodoWrite tool_use.  Hides itself when:
 *   - the todos list is empty, OR
 *   - every item in the list is `completed` (the work is done — pinning
 *     a fully-checked list at the bottom forever is just clutter; the
 *     conversation history above already records what was finished).
 *
 * Visibility is list-driven, not toggle-driven, so the panel reappears
 * automatically the moment the agent calls TodoWrite again.
 *
 * Staleness contract (added 2026-05-12):
 *   - The panel knows which assistant message owns the latest
 *     TodoWrite and how many assistant turns have passed since.
 *   - After `STALE_THRESHOLD_TURNS` further turns without a TodoWrite,
 *     the panel flags itself as stale: the header shows a warning
 *     pip and the in-progress row dims.  This catches the common
 *     failure where the agent keeps working but forgets to refresh
 *     the checklist.
 *   - The user can override a row's status to `completed` directly
 *     in the UI.  The override is local (no message sent), is keyed
 *     to the current `sourceMessageId`, and clears the moment the
 *     agent writes a new TodoWrite (the agent's view wins).
 */
import "../styles/components/TodoPanel.css";
import { useEffect, useState } from "react";
import {
  todoCounts,
  type TodoItem,
  type TodoSnapshot,
  type TodoStatus,
} from "../utils/todoStore";

/* `▸` is the universal disclosure glyph (panel/row collapse).  We
 * deliberately do NOT reuse it for `in_progress` — that's a state, not
 * a disclosure.  `❯` reads as an active mark (the operator's caret
 * shape) and pulses in CSS so it carries weight without competing
 * with the surrounding disclosure controls. */
const STATUS_GLYPH: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "❯",
  completed: "✓",
  unknown: "?",
};

/** How many additional assistant turns after the latest TodoWrite
 *  before the panel flags itself as stale.  Conservative — most
 *  multi-step tasks emit a TodoWrite every couple of turns. */
const STALE_THRESHOLD_TURNS = 3;

interface Props {
  /** Preferred API: a full snapshot from `extractTodoSnapshot`.
   *  When provided, the panel surfaces staleness state. */
  snapshot?: TodoSnapshot;
  /** Legacy / test prop: bare list of todos.  Kept so existing tests
   *  that build a list directly still work without ceremony. */
  todos?: TodoItem[];
}

export function TodoPanel({ snapshot, todos: legacyTodos }: Props) {
  const todos = snapshot?.todos ?? legacyTodos ?? [];
  const sourceMessageId = snapshot?.sourceMessageId ?? null;
  const assistantTurnsSince = snapshot?.assistantTurnsSince ?? 0;
  const isStale =
    !!snapshot && assistantTurnsSince >= STALE_THRESHOLD_TURNS;

  // Local "mark as done" overrides.  Keyed by content (we don't have
  // stable ids on todos).  Reset every time the source message id
  // changes — i.e., the agent wrote a fresh TodoWrite, which is
  // authoritative.
  const [localDone, setLocalDone] = useState<Set<string>>(new Set());
  useEffect(() => {
    setLocalDone(new Set());
  }, [sourceMessageId]);

  const [collapsed, setCollapsed] = useState(false);
  if (todos.length === 0) return null;

  const effectiveTodos: TodoItem[] = todos.map((t) =>
    localDone.has(t.content) && t.status !== "completed"
      ? { ...t, status: "completed" as TodoStatus }
      : t,
  );

  const { done, total } = todoCounts(effectiveTodos);
  // Auto-dismiss: a fully-completed list is past the user's "what's
  // happening now" view.  Hide rather than keep it pinned to the bottom.
  if (total > 0 && done === total) return null;

  const inProgress = effectiveTodos.find((t) => t.status === "in_progress");

  const toggleLocalDone = (content: string) => {
    setLocalDone((prev) => {
      const next = new Set(prev);
      if (next.has(content)) next.delete(content);
      else next.add(content);
      return next;
    });
  };

  return (
    <aside
      className="todo-panel"
      data-testid="todo-panel"
      data-stale={isStale || undefined}
    >
      <button
        type="button"
        className="todo-panel-header"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
      >
        <span className="todo-panel-title">TODOS</span>
        <span className="todo-panel-sep">·</span>
        <span className="todo-panel-count">{done}/{total}</span>
        {isStale && (
          <>
            <span className="todo-panel-sep">·</span>
            <span
              className="todo-panel-stale"
              title={`No update for ${assistantTurnsSince} turn${assistantTurnsSince === 1 ? "" : "s"} — the agent may be working without refreshing this list.`}
            >
              <span className="todo-panel-stale-dot" aria-hidden="true" />
              <span className="todo-panel-stale-word">stale</span>
              <span className="todo-panel-stale-detail">
                {assistantTurnsSince} turn{assistantTurnsSince === 1 ? "" : "s"} ago
              </span>
            </span>
          </>
        )}
        {collapsed && inProgress && (
          <>
            <span className="todo-panel-sep">·</span>
            <span className="todo-panel-running">
              running: {inProgress.content || "(empty)"}
            </span>
          </>
        )}
        <span className="todo-panel-disclosure" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
      </button>

      {!collapsed && (
        <ol className="todo-rows">
          {effectiveTodos.map((t, i) => {
            const isLocallyDone = localDone.has(t.content);
            const isInteractable = t.status !== "completed" || isLocallyDone;
            return (
              <li
                key={i}
                className="todo-row"
                data-status={t.status}
                data-local-done={isLocallyDone || undefined}
              >
                <span className="todo-glyph" aria-hidden="true">
                  {STATUS_GLYPH[t.status]}
                </span>
                <span className="todo-content">
                  {t.content === "" ? (
                    <span className="todo-empty">(empty)</span>
                  ) : (
                    t.content
                  )}
                </span>
                {t.status === "in_progress" && !isLocallyDone && (
                  <span className="todo-active-marker" aria-hidden="true">
                    ←
                  </span>
                )}
                {isInteractable && (
                  <button
                    type="button"
                    className="todo-row-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleLocalDone(t.content);
                    }}
                    title={
                      isLocallyDone
                        ? "Undo: restore the agent's status"
                        : "Mark this done (local — the agent's status is unchanged)"
                    }
                    aria-label={
                      isLocallyDone ? "Undo mark done" : "Mark done"
                    }
                  >
                    {isLocallyDone ? "↺" : "✓"}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
