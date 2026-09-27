/**
 * `selectFatalError` — pull the result-event error information that
 * the AgentSessionView surfaces as a banner.
 *
 * Background: a `result` event with `is_error: true` (e.g. "prompt is
 * too long") sets `state.lastError` (messageStore.ts) but no UI
 * previously read it.  The agent subprocess exits with code 0 in
 * this case, so the `agent-exit-notice` path never fires either —
 * users saw the conversation freeze with no explanation.
 *
 * This selector decides whether to render the banner and which copy
 * variant to use.  It is a pure read-only view over the message
 * store; the banner component just subscribes to its output.
 */
import type { AgentSessionState } from "./messageStore";

export interface FatalError {
  /** Human-readable error message — what to show the user. */
  message: string;
  /** True when the message looks like a context-window-exhausted
   *  failure ("prompt is too long", "context_length_exceeded", etc.).
   *  When true the banner adds a recovery hint pointing at /compact
   *  and /branch. */
  isContextLimit: boolean;
}

/* Recognised context-limit signatures.  Conservative on purpose: we'd
 * rather miss a phrasing and show the generic banner than mislabel a
 * different error as recoverable-with-compact and send the user down
 * the wrong path. */
const CONTEXT_LIMIT_PATTERNS: RegExp[] = [
  /prompt is too long/i,
  /context[_\s-]?length[_\s-]?exceeded/i,
  /exceeds?\s+(?:the\s+)?(?:maximum\s+)?context(?:\s+window)?/i,
  /input is too long/i,
  /max[_\s-]?tokens/i,
];

function isContextLimitMessage(message: string): boolean {
  for (const re of CONTEXT_LIMIT_PATTERNS) {
    if (re.test(message)) return true;
  }
  return false;
}

export function selectFatalError(state: AgentSessionState): FatalError | null {
  // The banner only shows when the LAST result event was a hard error.
  // `lastError` alone is not enough — it can survive past a recovery
  // turn briefly between events.  Tying the banner to the result event
  // means it disappears the moment a successful turn lands.
  const result = state.resultEvent;
  if (!result || !result.is_error) return null;

  // Prefer the captured lastError text (which folds in parse_error
  // origins too); fall back to the result's own `result` string; then
  // to a generic stub keyed on the subtype.
  const message =
    state.lastError
    ?? (typeof result.result === "string" ? result.result : null)
    ?? `Agent returned ${result.subtype ?? "error"}`;

  return {
    message,
    isContextLimit: isContextLimitMessage(message),
  };
}
