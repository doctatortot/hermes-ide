/**
 * MarginDraft — rolling 2-line preview of the agent's narration.
 *
 * Sits directly above the Footline.  Dim italic Newsreader serif.
 * Single brass hairline rail on the left, pulsing on the same 1.06 s
 * rhythm — the only sustained motion in the working surface.
 *
 * Lines arrive pre-trimmed from `selectWorkingState`; this component
 * is purely presentational.  When `lines` is empty, the component
 * renders nothing (the rail vanishes too).
 *
 * The user-prompt fallback line is encoded with a zero-width-space
 * sentinel (`MARGIN_DRAFT_FALLBACK_PREFIX`); we strip it here and
 * render the "responding to" label as a small mono uppercase kicker
 * so it reads as metadata, not as live agent narration.
 *
 * Design: `docs/design/agent-working-experience.html`.
 */
import {
  MARGIN_DRAFT_FALLBACK_PREFIX,
  type WorkingState,
} from "./workingState";

interface MarginDraftProps {
  state: WorkingState;
}

function splitPrefix(line: string): { prefix: string | null; body: string } {
  if (line.startsWith(MARGIN_DRAFT_FALLBACK_PREFIX)) {
    return {
      prefix: "responding to",
      body: line.slice(MARGIN_DRAFT_FALLBACK_PREFIX.length),
    };
  }
  return { prefix: null, body: line };
}

export function MarginDraft({ state }: MarginDraftProps) {
  if (!state.active) return null;
  if (state.marginDraftLines.length === 0) return null;

  return (
    <div className="agent-margin-draft" aria-hidden="true">
      {state.marginDraftLines.map((line, i) => {
        const { prefix, body } = splitPrefix(line);
        const isFresh = i === state.marginDraftLines.length - 1;
        return (
          <p
            key={i}
            className={"agent-margin-draft-line" + (isFresh ? " fresh" : "")}
          >
            {prefix && (
              <span className="agent-margin-draft-prefix">{prefix}</span>
            )}
            <span className="agent-margin-draft-body">{body}</span>
          </p>
        );
      })}
    </div>
  );
}
