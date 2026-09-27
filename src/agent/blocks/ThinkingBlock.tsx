import { useEffect, useRef, useState } from "react";
import type { ThinkingBlockData } from "../types";

interface ThinkingBlockProps {
  block: ThinkingBlockData;
  /**
   * Explicit override.  When provided, controls the initial open state
   * and disables the live auto-expand / auto-collapse heuristic.  Not
   * passed by the message renderer — only used in tests + storybooks.
   */
  defaultOpen?: boolean;
  /**
   * Frozen elapsed ms (set by the reducer once the thinking block has ended).
   * When provided, the elapsed counter renders this value verbatim.
   */
  elapsedMs?: number;
  /**
   * Live ticker base (set by the reducer the first time this thinking block
   * was observed). When provided *and* `elapsedMs` is undefined, the component
   * runs a 10Hz interval to render `Date.now() - startedAt`.
   */
  startedAt?: number;
}

/**
 * Collapsible thinking block.
 *
 * Open-state heuristic (matches the operator's intuition that live
 * reasoning is interesting, recorded reasoning is clutter):
 *
 *   • while `live` (deltas still arriving)        → open by default
 *   • when `live` flips to false (block ended)    → auto-collapse
 *   • the moment the user toggles manually        → respect their
 *     choice for the rest of the block's lifetime
 *
 * `defaultOpen`, when provided, overrides both the initial state and
 * the auto-collapse — it pins the block to that value.  Tests use it;
 * production code does not.
 */
export function ThinkingBlock({
  block,
  defaultOpen,
  elapsedMs,
  startedAt,
}: ThinkingBlockProps) {
  const live = startedAt !== undefined && elapsedMs === undefined;

  // Initial open state: explicit prop wins, otherwise auto-open while live.
  const [open, setOpen] = useState(
    defaultOpen !== undefined ? defaultOpen : live,
  );
  // Tracks whether the operator has clicked the chevron — once true,
  // the live-state effect stops overriding their choice.
  const userTouchedRef = useRef(false);

  // `tick` exists only to force re-renders during the live phase. We compute
  // the displayed value from `Date.now() - startedAt` directly so the value
  // stays current even if React batches.
  const [, setTick] = useState(0);

  // Sync `open` with `live` transitions — auto-collapse on completion.
  // Skipped when `defaultOpen` is provided (test pin) or when the user
  // has manually toggled (their preference wins).
  useEffect(() => {
    if (defaultOpen !== undefined) return;
    if (userTouchedRef.current) return;
    setOpen(live);
  }, [live, defaultOpen]);

  // Live-update the elapsed counter while we're streaming.
  // Once `elapsedMs` is provided, the reducer has frozen the value; stop ticking.
  //
  // AGENT-20: tick at 100ms only while elapsed < 10s (formatter shows tenths
  // there); after that, drop to 1Hz since the formatter only renders integer
  // seconds. With many simultaneous thinking blocks (sub-agents, forks),
  // this avoids 10× redundant re-renders per block per second.
  useEffect(() => {
    if (!live || startedAt === undefined) return;
    let cancelled = false;
    const FAST_TICK_MS = 100;
    const SLOW_TICK_MS = 1000;
    const FAST_PHASE_MS = 10_000;

    const schedule = (ms: number) => {
      if (cancelled) return;
      timer = setTimeout(() => {
        if (cancelled) return;
        setTick((t) => t + 1);
        const elapsedMs = Date.now() - startedAt;
        schedule(elapsedMs < FAST_PHASE_MS ? FAST_TICK_MS : SLOW_TICK_MS);
      }, ms);
    };

    let timer: ReturnType<typeof setTimeout>;
    const initialElapsed = Date.now() - startedAt;
    schedule(initialElapsed < FAST_PHASE_MS ? FAST_TICK_MS : SLOW_TICK_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer!);
    };
  }, [live, startedAt]);

  const elapsed =
    elapsedMs !== undefined
      ? elapsedMs
      : startedAt !== undefined
      ? Math.max(0, Date.now() - startedAt)
      : null;

  const elapsedLabel = elapsed !== null ? formatElapsedSeconds(elapsed) : null;

  const thinkingText = block.thinking ?? "";
  const hasText = thinkingText.trim().length > 0;

  // After ~3 s of live-but-empty, switch the placeholder away from
  // the "will appear as it streams" promise — at that point we don't
  // actually know whether deltas are coming late, being suppressed by
  // the SDK/model/config, or genuinely never arriving.  Stick to what
  // we can prove: no text has streamed yet.  Don't speculate about
  // why.
  const elapsedMsForCopy = elapsed ?? 0;
  const placeholder =
    !live
      ? "(no recorded reasoning)"
      : elapsedMsForCopy < 3_000
      ? "Reasoning will appear here as the model streams it…"
      : "No reasoning text has streamed yet — the model may emit it later or all at once.";

  return (
    <div
      className={`agent-thinking-block${open ? " open" : ""}${
        live ? " live" : ""
      }`}
    >
      <button
        type="button"
        className="agent-thinking-toggle"
        onClick={() => {
          userTouchedRef.current = true;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
      >
        <span className="agent-thinking-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="agent-thinking-label">
          {live ? "thinking" : "thought"}
        </span>
        {elapsedLabel !== null ? (
          <span className="agent-thinking-elapsed">{elapsedLabel}</span>
        ) : null}
        {live && !open ? (
          <span className="agent-thinking-hint" aria-hidden="true">
            click to read
          </span>
        ) : null}
      </button>
      {open ? (
        <pre className="agent-thinking-body">
          {hasText ? (
            thinkingText
          ) : (
            <span className="agent-thinking-placeholder">{placeholder}</span>
          )}
          {live && hasText ? (
            <span
              className="agent-thinking-pulse"
              aria-hidden="true"
            />
          ) : null}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * Format an elapsed milliseconds value as a compact mono-number string.
 * Mirrors the playbook §6 spec:
 *   < 10s → one decimal place ("0.4s", "8.5s")
 *   ≥ 10s → integer seconds ("24s")
 */
export function formatElapsedSeconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}
