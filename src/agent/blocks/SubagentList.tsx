/**
 * SubagentList — inline rows under a Task tool_use block.
 *
 * Renders the subagents spawned by a single Task call as a compact list:
 *
 *   ▸  ●  #1 audit-main  ·  4s         ·  (+2)
 *   ▸  ●  #2 audit-fix   ·  12s  · Bash
 *   ─── 3 done ───
 *
 * Compact rows show: chev + state dot + name + elapsed + (+N) nested
 * hint.  Done rows auto-collapse 5s after entering `done` into a
 * single `N done` rollup line at the bottom of the list.  Click any
 * row to expand and read the subagent's final reply (with a link to
 * the full transcript).
 *
 * No interrupt control.  No live streaming preview.  Read-only.
 *
 * See `docs/superpowers/specs/2026-05-12-subagent-visibility-design.md`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSessionState, RenderedMessage } from "../messageStore";
import { selectSubagentsForTool, type SubagentRow } from "../subagentSelectors";
import { MarkdownBody } from "./MarkdownBody";
import { ExpandedViewModal } from "./ExpandedViewModal";

interface SubagentListProps {
  toolUseId: string;
  state: AgentSessionState;
}

const AUTO_COLLAPSE_MS = 5000;

export function SubagentList({ toolUseId, state }: SubagentListProps) {
  const rows = useMemo(
    () => selectSubagentsForTool(state, toolUseId),
    [state, toolUseId],
  );

  // Per-row collapse tracking.  Once a row has been auto-collapsed,
  // we keep the id in `collapsed`; the row is then hidden from the
  // visible list and counted in the `N done` rollup.  Manually-
  // expanded rows track their open state separately and never
  // auto-collapse.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const timerRefs = useRef(new Map<string, number>());

  // Start auto-collapse timers when rows enter `done`.  If the row is
  // currently expanded, no timer — we wait until the user closes it.
  useEffect(() => {
    for (const row of rows) {
      if (row.state !== "done") continue;
      if (collapsedIds.has(row.id)) continue;
      if (expandedIds.has(row.id)) continue;
      if (timerRefs.current.has(row.id)) continue;
      const id = window.setTimeout(() => {
        setCollapsedIds((prev) => {
          if (prev.has(row.id)) return prev;
          const next = new Set(prev);
          next.add(row.id);
          return next;
        });
        timerRefs.current.delete(row.id);
      }, AUTO_COLLAPSE_MS);
      timerRefs.current.set(row.id, id);
    }
    // Cleanup: if rows disappear (e.g., session reset), clear their
    // timers.
    const aliveIds = new Set(rows.map((r) => r.id));
    for (const [id, timeoutId] of timerRefs.current.entries()) {
      if (!aliveIds.has(id)) {
        window.clearTimeout(timeoutId);
        timerRefs.current.delete(id);
      }
    }
    // Snapshot the ref into a local so the cleanup closure doesn't
    // observe a mutated value on unmount.
    return () => {
      // Note: we don't clear on every effect run — only on unmount.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // Final unmount: kill every pending timer.
  useEffect(() => {
    const map = timerRefs.current;
    return () => {
      for (const id of map.values()) window.clearTimeout(id);
      map.clear();
    };
  }, []);

  // Cancel the auto-collapse timer for any row that gets manually
  // expanded.
  const handleToggleExpand = (rowId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
    const t = timerRefs.current.get(rowId);
    if (t) {
      window.clearTimeout(t);
      timerRefs.current.delete(rowId);
    }
  };

  if (rows.length === 0) return null;

  const visibleRows = rows.filter((r) => !collapsedIds.has(r.id));
  const collapsedRows = rows.filter((r) => collapsedIds.has(r.id));

  return (
    <div className="agent-subagent-list" aria-label="Subagents">
      {visibleRows.map((row) => (
        <SubagentRowView
          key={row.id}
          row={row}
          expanded={expandedIds.has(row.id)}
          onToggle={() => handleToggleExpand(row.id)}
        />
      ))}
      {collapsedRows.length > 0 && (
        <CollapsedRollup
          rows={collapsedRows}
          expandedIds={expandedIds}
          onToggleExpand={handleToggleExpand}
        />
      )}
    </div>
  );
}

/* ─── Row ──────────────────────────────────────────────────────────── */

function SubagentRowView({
  row,
  expanded,
  onToggle,
}: {
  row: SubagentRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="agent-subagent-row"
        data-state={row.state}
        data-expanded={expanded || undefined}
        onClick={onToggle}
        title={row.name}
        aria-expanded={expanded}
      >
        <span className="agent-subagent-chev" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span
          className="agent-subagent-dot"
          data-state={row.state}
          aria-hidden="true"
        />
        <span className="agent-subagent-name">{row.name}</span>
        <span className="agent-subagent-spacer" />
        <Elapsed since={row.since} doneAt={row.doneAt} state={row.state} />
        {row.nestedRunningCount > 0 && (
          <span
            className="agent-subagent-nested"
            title={`${row.nestedRunningCount} nested subagent${row.nestedRunningCount === 1 ? "" : "s"} still running`}
          >
            (+{row.nestedRunningCount})
          </span>
        )}
      </button>
      {expanded && <ExpandedSubagent row={row} />}
    </>
  );
}

function Elapsed({
  since,
  doneAt,
  state,
}: {
  since: number;
  doneAt: number | null;
  state: SubagentRow["state"];
}) {
  // Live-tick for thinking/running.  Frozen on done.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (state === "done") return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [state]);
  void tick;

  const end = state === "done" ? doneAt ?? Date.now() : Date.now();
  const seconds = Math.max(0, Math.floor((end - since) / 1000));
  const label =
    state === "done" ? `done · ${seconds}s` : `${seconds}s`;

  return (
    <span className="agent-subagent-elapsed" data-state={state}>
      {label}
    </span>
  );
}

/* ─── Expanded body ────────────────────────────────────────────────── */

function ExpandedSubagent({ row }: { row: SubagentRow }) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  return (
    <div className="agent-subagent-expanded">
      {row.lastReply ? (
        <MarkdownBody source={row.lastReply.text} />
      ) : (
        <p className="agent-subagent-empty">— no output —</p>
      )}
      <button
        type="button"
        className="agent-subagent-transcript-link"
        onClick={() => setTranscriptOpen(true)}
      >
        Show full transcript ↘
      </button>
      {transcriptOpen && (
        <ExpandedViewModal
          title={`subagent · ${row.name}`}
          onClose={() => setTranscriptOpen(false)}
        >
          <SubagentTranscript transcript={row.transcript} />
        </ExpandedViewModal>
      )}
    </div>
  );
}

function SubagentTranscript({
  transcript,
}: {
  transcript: RenderedMessage[];
}) {
  // Lightweight transcript renderer: walks every message in the
  // subagent's thread and surfaces text blocks + tool_use names.
  // Intentionally minimal — full block fidelity lives in the main
  // conversation pane.
  return (
    <div className="agent-subagent-transcript">
      {transcript.map((m) => (
        <div
          key={`${m.id}-${m.timestamp ?? ""}`}
          className="agent-subagent-transcript-msg"
          data-role={m.role}
        >
          {m.blocks.map((block, i) => {
            if (block.type === "text") {
              return (
                <div key={i} className="agent-subagent-transcript-text">
                  <MarkdownBody source={(block as { text: string }).text} />
                </div>
              );
            }
            if (block.type === "tool_use") {
              const b = block as { name: string; id: string };
              return (
                <div key={i} className="agent-subagent-transcript-tool">
                  <span className="agent-subagent-transcript-tool-name">
                    {b.name}
                  </span>
                </div>
              );
            }
            if (block.type === "thinking") {
              return (
                <div key={i} className="agent-subagent-transcript-thinking">
                  <em>
                    {(block as { thinking: string }).thinking.slice(0, 240)}
                  </em>
                </div>
              );
            }
            return null;
          })}
        </div>
      ))}
    </div>
  );
}

/* ─── Collapsed rollup ─────────────────────────────────────────────── */

function CollapsedRollup({
  rows,
  expandedIds,
  onToggleExpand,
}: {
  rows: SubagentRow[];
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="agent-subagent-rollup">
      <button
        type="button"
        className="agent-subagent-rollup-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>{" "}
        <span className="agent-subagent-rollup-count">{rows.length}</span> done
      </button>
      {open && (
        <div className="agent-subagent-rollup-list">
          {rows.map((row) => (
            <SubagentRowView
              key={row.id}
              row={row}
              expanded={expandedIds.has(row.id)}
              onToggle={() => onToggleExpand(row.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
