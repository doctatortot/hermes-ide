// @vitest-environment jsdom
/**
 * Tests for the ThinkingBlock "live auto-open" heuristic.
 *
 * Contract:
 *   • While live (startedAt set, elapsedMs undefined) → open by default,
 *     so the operator can read the reasoning as it streams.
 *   • When live ends (elapsedMs becomes defined) → auto-collapse, so
 *     the conversation history doesn't get cluttered with raw reasoning.
 *   • If the user manually toggles → their choice is respected from
 *     that point forward (the live-state effect stops overriding).
 *   • The empty-text placeholder is shown while live but no deltas
 *     have arrived yet (otherwise the open card looks broken in the
 *     first few hundred ms of streaming).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ThinkingBlock } from "../agent/blocks/ThinkingBlock";
import type { ThinkingBlockData } from "../agent/types";

afterEach(() => cleanup());

const block = (s: string): ThinkingBlockData => ({
  type: "thinking",
  thinking: s,
});

describe("ThinkingBlock — live auto-open", () => {
  it("opens by default while live (startedAt set, no elapsedMs)", () => {
    const { container } = render(
      <ThinkingBlock
        block={block("Let me consider the auth module first.")}
        startedAt={Date.now() - 2_000}
      />,
    );
    const wrapper = container.querySelector(".agent-thinking-block");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.classList.contains("open")).toBe(true);
    expect(wrapper!.classList.contains("live")).toBe(true);
    const body = container.querySelector(".agent-thinking-body");
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain("Let me consider");
  });

  it("collapses by default when not live (elapsedMs frozen)", () => {
    const { container } = render(
      <ThinkingBlock
        block={block("Done reasoning.")}
        startedAt={1000}
        elapsedMs={5_000}
      />,
    );
    const wrapper = container.querySelector(".agent-thinking-block");
    expect(wrapper!.classList.contains("open")).toBe(false);
    expect(wrapper!.classList.contains("live")).toBe(false);
    expect(container.querySelector(".agent-thinking-body")).toBeNull();
  });

  it("auto-collapses when live transitions to done", () => {
    const { container, rerender } = render(
      <ThinkingBlock
        block={block("Mid-thought…")}
        startedAt={Date.now() - 1_000}
      />,
    );
    expect(
      container
        .querySelector(".agent-thinking-block")!
        .classList.contains("open"),
    ).toBe(true);

    rerender(
      <ThinkingBlock
        block={block("Mid-thought… done.")}
        startedAt={1000}
        elapsedMs={3_000}
      />,
    );
    expect(
      container
        .querySelector(".agent-thinking-block")!
        .classList.contains("open"),
    ).toBe(false);
  });

  it("respects the user's manual toggle (live → user closes → stays closed)", () => {
    const { container } = render(
      <ThinkingBlock
        block={block("Live reasoning text.")}
        startedAt={Date.now() - 1_000}
      />,
    );
    const toggle = container.querySelector(
      ".agent-thinking-toggle",
    ) as HTMLButtonElement;
    expect(
      container
        .querySelector(".agent-thinking-block")!
        .classList.contains("open"),
    ).toBe(true);

    fireEvent.click(toggle);
    expect(
      container
        .querySelector(".agent-thinking-block")!
        .classList.contains("open"),
    ).toBe(false);
  });

  it("respects the user's manual toggle across the live → done transition", () => {
    const { container, rerender } = render(
      <ThinkingBlock
        block={block("Live reasoning.")}
        startedAt={Date.now() - 1_000}
      />,
    );
    const toggle = container.querySelector(
      ".agent-thinking-toggle",
    ) as HTMLButtonElement;
    // User explicitly opens (it's already open, so closes then re-opens).
    fireEvent.click(toggle); // close
    fireEvent.click(toggle); // re-open — userTouched is now sticky
    expect(
      container
        .querySelector(".agent-thinking-block")!
        .classList.contains("open"),
    ).toBe(true);

    // Stream ends.  Without userTouched, this would auto-collapse.
    rerender(
      <ThinkingBlock
        block={block("Live reasoning, done.")}
        startedAt={1000}
        elapsedMs={3_000}
      />,
    );
    expect(
      container
        .querySelector(".agent-thinking-block")!
        .classList.contains("open"),
    ).toBe(true);
  });

  it("shows a placeholder while live with no deltas yet", () => {
    const { container } = render(
      <ThinkingBlock
        block={block("")}
        startedAt={Date.now() - 500}
      />,
    );
    const placeholder = container.querySelector(
      ".agent-thinking-placeholder",
    );
    expect(placeholder).not.toBeNull();
    expect(placeholder!.textContent).toMatch(/will appear here/);
  });

  it("shows the live pulse cursor when streaming with text", () => {
    const { container } = render(
      <ThinkingBlock
        block={block("Mid-thought.")}
        startedAt={Date.now() - 500}
      />,
    );
    expect(container.querySelector(".agent-thinking-pulse")).not.toBeNull();
  });

  it("does NOT show the live pulse cursor when not live", () => {
    const { container } = render(
      <ThinkingBlock
        block={block("Recorded thought.")}
        startedAt={1000}
        elapsedMs={5_000}
        defaultOpen={true}
      />,
    );
    expect(container.querySelector(".agent-thinking-pulse")).toBeNull();
  });

  it("honours explicit defaultOpen=false even when live", () => {
    const { container } = render(
      <ThinkingBlock
        block={block("Live reasoning.")}
        startedAt={Date.now() - 500}
        defaultOpen={false}
      />,
    );
    expect(
      container
        .querySelector(".agent-thinking-block")!
        .classList.contains("open"),
    ).toBe(false);
  });

  it("shows the 'click to read' hint when live + collapsed", () => {
    const { container } = render(
      <ThinkingBlock
        block={block("Live reasoning.")}
        startedAt={Date.now() - 500}
        defaultOpen={false}
      />,
    );
    const hint = container.querySelector(".agent-thinking-hint");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toMatch(/click to read/);
  });

  it("after 3 s of empty live thinking, switches the placeholder to a non-committal copy", () => {
    // We don't know WHY the deltas haven't arrived — they may be
    // suppressed by the model/config, batched by the SDK, or just
    // late.  The placeholder should stick to provable facts ("no text
    // has streamed") and not speculate.
    const { container } = render(
      <ThinkingBlock
        block={block("")}
        startedAt={Date.now() - 5_000}
      />,
    );
    const placeholder = container.querySelector(
      ".agent-thinking-placeholder",
    );
    expect(placeholder).not.toBeNull();
    // Loose match — the exact words may evolve, but the intent is
    // that we acknowledge silence without making claims about cause.
    expect(placeholder!.textContent).toMatch(/no reasoning text/i);
    // The earlier "will appear as it streams…" promise should NOT be
    // present once we've waited past the initial 3 s window.
    expect(placeholder!.textContent).not.toMatch(/will appear/i);
  });
});
