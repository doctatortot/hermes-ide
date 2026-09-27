/**
 * `selectFatalError` — picks the result-event-error info that the
 * AgentSessionView banner renders, and classifies whether it's a
 * recoverable-with-compact context-limit error vs an opaque server
 * error.
 *
 * Background: result events with `is_error: true` (e.g. "prompt is
 * too long") used to be silently captured into `state.lastError` and
 * never surfaced to the user — see `agent-message-store.test.ts`
 * lifecycle tests for the storage contract.  This selector is what
 * the AgentSessionView reads to decide whether to render the banner
 * and which copy variant to show.
 */
import { describe, it, expect } from "vitest";
import { emptyState, reduceEvent } from "../agent/messageStore";
import { selectFatalError } from "../agent/errorSelector";
import type { ResultEvent } from "../agent/types";

describe("selectFatalError", () => {
  it("returns null on empty state", () => {
    expect(selectFatalError(emptyState())).toBeNull();
  });

  it("returns null when the last result was successful", () => {
    const state = reduceEvent(emptyState(), {
      type: "result",
      subtype: "success",
      is_error: false,
    } as ResultEvent);
    expect(selectFatalError(state)).toBeNull();
  });

  it("returns the error message when the last result was is_error: true", () => {
    const state = reduceEvent(emptyState(), {
      type: "result",
      subtype: "error",
      is_error: true,
      result: "prompt is too long: 230000 tokens > 200000",
    } as ResultEvent);
    const fatal = selectFatalError(state);
    expect(fatal).not.toBeNull();
    expect(fatal!.message).toContain("prompt is too long");
  });

  it("classifies `prompt is too long` as a context-limit error", () => {
    const state = reduceEvent(emptyState(), {
      type: "result",
      subtype: "error",
      is_error: true,
      result: "prompt is too long: 230000 tokens > 200000",
    } as ResultEvent);
    const fatal = selectFatalError(state)!;
    expect(fatal.isContextLimit).toBe(true);
  });

  it("classifies `context_length_exceeded` as a context-limit error", () => {
    const state = reduceEvent(emptyState(), {
      type: "result",
      subtype: "error",
      is_error: true,
      result: "API Error: context_length_exceeded",
    } as ResultEvent);
    const fatal = selectFatalError(state)!;
    expect(fatal.isContextLimit).toBe(true);
  });

  it("classifies the bare phrase `exceeds the maximum context` as context-limit", () => {
    const state = reduceEvent(emptyState(), {
      type: "result",
      subtype: "error",
      is_error: true,
      result: "input exceeds the maximum context window for this model",
    } as ResultEvent);
    expect(selectFatalError(state)!.isContextLimit).toBe(true);
  });

  it("does NOT flag a generic server error as a context-limit error", () => {
    const state = reduceEvent(emptyState(), {
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Internal server error (500)",
    } as ResultEvent);
    const fatal = selectFatalError(state)!;
    expect(fatal.isContextLimit).toBe(false);
  });

  it("vanishes after a successful turn lands (post-recovery)", () => {
    let state = emptyState();
    state = reduceEvent(state, {
      type: "result",
      subtype: "error",
      is_error: true,
      result: "prompt is too long",
    } as ResultEvent);
    expect(selectFatalError(state)).not.toBeNull();
    state = reduceEvent(state, {
      type: "result",
      subtype: "success",
      is_error: false,
    } as ResultEvent);
    expect(selectFatalError(state)).toBeNull();
  });

  it("falls back to the subtype name when result string is absent", () => {
    const state = reduceEvent(emptyState(), {
      type: "result",
      subtype: "error",
      is_error: true,
      // no `result` field
    } as ResultEvent);
    const fatal = selectFatalError(state)!;
    expect(fatal.message).toMatch(/error/i);
  });

  it("case-insensitive context-limit detection", () => {
    const state = reduceEvent(emptyState(), {
      type: "result",
      subtype: "error",
      is_error: true,
      result: "PROMPT IS TOO LONG",
    } as ResultEvent);
    expect(selectFatalError(state)!.isContextLimit).toBe(true);
  });
});
