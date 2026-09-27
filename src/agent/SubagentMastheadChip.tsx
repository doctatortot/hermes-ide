/**
 * SubagentMastheadChip — at-a-glance "N subagents running" pill in the
 * session header.  Click to open a popover listing every currently
 * running subagent flattened across the session; click a row to scroll
 * the conversation back to its parent Task block.
 *
 * Hidden entirely when there are zero running subagents.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSessionState } from "./messageStore";
import {
  selectSubagentCounts,
  selectSubagentsForTool,
  isTaskTool,
} from "./subagentSelectors";
import { isToolUseBlock } from "./types";

interface SubagentMastheadChipProps {
  state: AgentSessionState;
  /** Called with a target DOM-friendly anchor when the user clicks
   *  a row in the popover.  The host scrolls the conversation to
   *  show the matching message / Task block. */
  onJumpTo?: (messageId: string) => void;
}

/** A single row to surface in the popover.  Drives 1:1 from the same
 *  source the eye sees in the conversation: every visible Task
 *  tool_use that's still in-flight (no tool_result yet), plus any
 *  streaming subagents nested under it. */
interface FlatRow {
  /** Stable id used for the React key. */
  key: string;
  /** Display name (Task input.description or `subagent #N`). */
  name: string;
  /** ms timestamp the row first appeared. */
  since: number;
  /** Nesting depth — 0 for top-level Task tool_uses, 1+ for streamed
   *  fan-out subagents that themselves call Task. */
  depth: number;
  /** Message id to scroll to when the row is clicked. */
  parentMessageId: string;
}

function pickName(input: unknown, fallback: string): string {
  if (input && typeof input === "object") {
    const desc = (input as Record<string, unknown>).description;
    if (typeof desc === "string" && desc.trim()) {
      return desc.trim().split("\n")[0].slice(0, 80);
    }
    const sub = (input as Record<string, unknown>).subagent_type;
    if (typeof sub === "string" && sub.trim()) return sub.trim();
  }
  return fallback;
}

/** Flatten every IN-FLIGHT subagent (Task block without a
 *  tool_result yet, plus streaming descendants) across every depth.
 *  Pairs with `selectSubagentCounts.running` 1:1. */
function flattenRunning(state: AgentSessionState): FlatRow[] {
  const out: FlatRow[] = [];
  const seen = new Set<string>();

  function visit(
    toolUseId: string,
    name: string,
    since: number,
    depth: number,
    parentMessageId: string,
  ) {
    if (seen.has(toolUseId)) return;
    seen.add(toolUseId);
    // In-flight only — show the rows that haven't yet returned.
    if (!state.toolResults.has(toolUseId)) {
      out.push({
        key: toolUseId,
        name,
        since,
        depth,
        parentMessageId,
      });
    }
    // Walk any streaming subagent rows nested under this Task —
    // they may host their own Task calls (recursive fan-out).
    for (const row of selectSubagentsForTool(state, toolUseId)) {
      for (const m of row.transcript) {
        if (m.role !== "assistant") continue;
        for (const block of m.blocks) {
          if (isToolUseBlock(block) && isTaskTool(block.name)) {
            visit(
              block.id,
              pickName(block.input, row.name),
              m.timestamp ?? Date.now(),
              depth + 1,
              m.id,
            );
          }
        }
      }
    }
  }

  for (const m of state.messages) {
    if (m.parentToolUseId) continue;
    if (m.role !== "assistant") continue;
    for (const block of m.blocks) {
      if (isToolUseBlock(block) && isTaskTool(block.name)) {
        visit(
          block.id,
          pickName(block.input, "subagent"),
          m.timestamp ?? Date.now(),
          0,
          m.id,
        );
      }
    }
  }

  return out;
}

export function SubagentMastheadChip({
  state,
  onJumpTo,
}: SubagentMastheadChipProps) {
  const counts = useMemo(() => selectSubagentCounts(state), [state]);
  const flat = useMemo(() => flattenRunning(state), [state]);

  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Close on Esc / outside click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  // Auto-close if running drops to zero.
  useEffect(() => {
    if (counts.running === 0 && open) setOpen(false);
  }, [counts.running, open]);

  if (counts.running === 0) return null;

  return (
    <span className="agent-subagent-chip-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="agent-subagent-chip"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${counts.running} subagent${counts.running === 1 ? "" : "s"} running`}
      >
        <span className="agent-subagent-chip-dot" aria-hidden="true" />
        <span className="agent-subagent-chip-count">{counts.running}</span>
        <span className="agent-subagent-chip-label">
          subagent{counts.running === 1 ? "" : "s"}
        </span>
        <span className="agent-subagent-chip-chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="agent-subagent-popover"
          role="dialog"
          aria-label="Running subagents"
        >
          <div className="agent-subagent-popover-header">
            <span className="agent-subagent-popover-kicker">Running</span>
            <span className="agent-subagent-popover-meta">
              {counts.running} active · {counts.done} done
            </span>
          </div>
          <div className="agent-subagent-popover-list">
            {flat.map((r) => (
              <button
                key={r.key}
                type="button"
                className="agent-subagent-popover-row"
                style={{ paddingLeft: 8 + r.depth * 12 }}
                onClick={() => {
                  setOpen(false);
                  onJumpTo?.(r.parentMessageId);
                }}
                title={`Jump to ${r.name}`}
              >
                <span
                  className="agent-subagent-dot"
                  data-state="running"
                  aria-hidden="true"
                />
                <span className="agent-subagent-popover-name">{r.name}</span>
                <span className="agent-subagent-popover-spacer" />
                <span className="agent-subagent-popover-elapsed">
                  {Math.max(0, Math.floor((Date.now() - r.since) / 1000))}s
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
