/**
 * WorkingFootline — the always-visible "agent is working" surface.
 *
 * A single horizontal strip that sits above the composer whenever the
 * agent is non-idle.  Shows:
 *
 *   italic verb · mono object  ········  0:17 · 188 tok · Stop  esc
 *
 * Verbs are present participles ("reading", "drafting", "thinking",
 * "coordinating", "stopping").  The object surfaces the concrete
 * thing the verb operates on (path, command, URL, pattern, subagent
 * count).  The chronograph is tabular mono.  The Stop affordance is
 * co-located so the cancel target is where the operator is already
 * looking.
 *
 * Design rationale: `docs/design/agent-working-experience.html`.
 */
import { useEffect, useState } from "react";
import type { WorkingObject, WorkingState, WorkingVerb } from "./workingState";

interface WorkingFootlineProps {
  state: WorkingState;
  /** Called when the operator presses Stop or the Esc key. */
  onStop?: () => void;
}

export function WorkingFootline({ state, onStop }: WorkingFootlineProps) {
  // Bind Esc → onStop while this footline is mounted.  Avoid binding
  // when no callback is provided so the host stays in control of
  // hotkey ownership.
  useEffect(() => {
    if (!onStop) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Skip when the user is mid-edit in an input/textarea/contenteditable.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
          return;
        }
      }
      e.preventDefault();
      onStop();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onStop]);

  if (!state.active) return null;

  const variant = variantFor(state.verb);

  return (
    <div
      className="agent-footline"
      data-variant={variant}
      role="status"
      aria-live="polite"
    >
      <div className="agent-footline-verb-block">
        <span className="agent-footline-verb">{state.verb}</span>
        <ObjectPreview
          verb={state.verb}
          object={state.object}
          since={state.since}
        />
      </div>
      <span className="agent-footline-spacer" />
      <span className="agent-footline-meter">
        <ElapsedCounter since={state.since} />
        <Sep />
        <span className="agent-footline-tokens">
          {formatTokens(state.cumulativeOutputTokens)} tok
        </span>
        {onStop && (
          <>
            <Sep />
            <button
              type="button"
              className="agent-footline-stop"
              onClick={onStop}
              aria-label="Stop the current turn"
              title="Stop the current turn (Esc)"
            >
              Stop <span className="agent-footline-stop-esc">esc</span>
            </button>
          </>
        )}
      </span>
    </div>
  );
}

/* ─── helpers ──────────────────────────────────────────────────────── */

/** Map a verb to the visual variant — the CSS toggles a couple of
 *  tinting overrides on top of the base footline (red for stopping,
 *  amber for waiting/rate-limited). */
function variantFor(verb: WorkingVerb): string {
  if (verb === "stopping") return "stopping";
  if (verb === "waiting") return "waiting";
  return "default";
}

/** Render the object descriptor according to verb.  Each branch
 *  produces a small monospace fragment in the same row. */
function ObjectPreview({
  verb,
  object,
  since,
}: {
  verb: WorkingVerb;
  object: WorkingObject;
  since: number | null;
}) {
  if (verb === "thinking") return null;
  if (verb === "awaiting") {
    return (
      <AwaitingDescriptor
        base={object.descriptor ?? "first byte"}
        since={since}
      />
    );
  }
  if (verb === "coordinating") {
    const counts = object.subagents;
    if (!counts) return null;
    return (
      <span className="agent-footline-object">
        <span className="agent-footline-object-path">
          {counts.running} of {counts.running + counts.done} subagents
        </span>
        {counts.done > 0 && (
          <span className="agent-footline-object-alt">
            {" · "}
            {counts.done} done
          </span>
        )}
      </span>
    );
  }
  if (verb === "drafting") {
    return (
      <span className="agent-footline-object">
        <span className="agent-footline-object-path">
          {object.descriptor ?? "reply"}
        </span>
      </span>
    );
  }
  // path / command / url / pattern verbs.
  const main =
    object.path ?? object.command ?? object.url ?? object.pattern ?? object.raw ?? "";
  if (!main) return null;
  return (
    <span
      className="agent-footline-object"
      title={main}
    >
      <span className="agent-footline-object-path">{main}</span>
    </span>
  );
}

function Sep() {
  return (
    <span className="agent-footline-sep" aria-hidden="true">
      ·
    </span>
  );
}

/** Reassuring sub-text shown for "awaiting" state.  The wait between
 *  "submit" and "first byte" can stretch to 30–60 s on long contexts
 *  or under high load; without an escalating message the operator
 *  thinks the IDE is hung.  Ticks once per second to update copy.
 *
 *   0–5 s    : "first byte"
 *   5–15 s   : "still negotiating with the API"
 *   15–45 s  : "long context — this can take 30–60 s"
 *   45 s+    : "still alive — long contexts can take a minute+"
 */
function AwaitingDescriptor({
  base,
  since,
}: {
  base: string;
  since: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [since]);

  const elapsedSec = since === null ? 0 : Math.max(0, (now - since) / 1000);
  let descriptor: string;
  if (elapsedSec < 5) {
    descriptor = base;
  } else if (elapsedSec < 15) {
    descriptor = `${base} · negotiating with the API`;
  } else if (elapsedSec < 45) {
    descriptor = `${base} · long context, may take 30–60s`;
  } else {
    descriptor = `${base} · still alive — large contexts can take a minute+`;
  }

  return (
    <span className="agent-footline-object">
      <span className="agent-footline-object-alt">{descriptor}</span>
    </span>
  );
}

/** Live-ticking m:ss counter, frozen when `since` is null. */
function ElapsedCounter({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    if (
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      // Still tick once per second — the value is informative, not
      // decorative.  The animation budget elsewhere stays zero.
    }
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [since]);
  if (since === null) {
    return <span className="agent-footline-elapsed">—</span>;
  }
  return (
    <span className="agent-footline-elapsed">{formatElapsed(now - since)}</span>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}
