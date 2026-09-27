/**
 * Subagent masthead popover — opaque, distinct, theme-consistent.
 *
 * History:
 *   v1.2.2 — popover used a layered `linear-gradient(--bg-elevated) over
 *            --bg-0` with `backdrop-filter: blur(10px)`.  The
 *            backdrop-filter leaked the chat behind through on some GPU
 *            compositors.
 *   v1.3.0 — collapsed to a single `var(--bg-elevated, var(--bg-1))`
 *            fill and dropped the backdrop-filter, fixing the leak.
 *   v1.3.1 — `--bg-elevated` was too close in luminance to `--bg-0` on
 *            warm-toned dark themes (atelier, observatory, phosphor),
 *            making the popover read as part of the page.  Additionally,
 *            on the frosted themes every other popover (`.context-menu`,
 *            `.status-theme-popover`) ran an Apple-HUD `rgba + blur`
 *            override and this one was the odd-one-out.  Fixed by:
 *              - base popover now sits on `--bg-2`, the same floating-
 *                panel token used by `.color-picker-popover` and matches
 *                the lift of `.agent-subagent-expanded`.
 *              - frosted-dark and frosted-light gained explicit
 *                `.agent-subagent-popover` entries in their glass
 *                selector group, so the popover frosts like its peers.
 *
 * These assertions pin the v1.3.1 invariants so the popover can't
 * regress to a low-contrast or inconsistent state.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const POPOVER_CSS_PATH = path.resolve(
  __dirname,
  "../styles/components/agent/AgentSessionView.css",
);
const THEMES_CSS_PATH = path.resolve(__dirname, "../styles/themes.css");

function ruleBody(css: string, selector: string): string {
  // Strip block comments so descriptive prose can't trip our assertions.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{",
  );
  const m = stripped.match(re);
  if (!m || m.index === undefined) return "";
  const open = stripped.indexOf("{", m.index);
  let depth = 1;
  for (let i = open + 1; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}") {
      depth--;
      if (depth === 0) return stripped.slice(open + 1, i);
    }
  }
  return "";
}

describe("Subagent popover — background opacity", () => {
  const css = fs.readFileSync(POPOVER_CSS_PATH, "utf-8");
  const body = ruleBody(css, ".agent-subagent-popover");

  it("popover rule exists", () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it("background is a single solid fill, not a layered gradient", () => {
    // Drop linear-gradient(...) entirely so a stray reference in a
    // comment in another rule can't false-positive — but the comment
    // strip above already handles that; this is belt + braces.
    expect(body).not.toMatch(/linear-gradient/);
  });

  it("background sits on --bg-2 (the floating-panel surface)", () => {
    // --bg-2 is the token used by every floating panel in the app
    // (`.color-picker-popover`, `.agent-subagent-expanded`).  It lifts
    // cleanly above both --bg-0 (header) and --bg-1 (conversation),
    // unlike --bg-elevated which sat too close to --bg-0 on warm themes.
    expect(body).toMatch(/background:\s*var\(--bg-2\)/);
  });

  it("does NOT set backdrop-filter on the base rule — it leaks through on some compositors", () => {
    // Frosted themes override this with rgba + blur in themes.css; the
    // base rule must stay free of backdrop-filter so non-frosted themes
    // get a clean solid fill.
    expect(body).not.toMatch(/backdrop-filter:/);
    expect(body).not.toMatch(/-webkit-backdrop-filter:/);
  });
});

describe("Subagent popover — frosted-theme glass overrides", () => {
  const themes = fs.readFileSync(THEMES_CSS_PATH, "utf-8");

  it("frosted-dark applies the Apple-HUD glass override to the subagent popover", () => {
    // Every popover on frosted-dark should get the same rgba + blur
    // treatment; the subagent popover must be in the selector group
    // alongside `.context-menu` and `.status-theme-popover`.
    expect(themes).toMatch(
      /html\[data-theme="frosted-dark"\]\s+\.agent-subagent-popover\s*\{|html\[data-theme="frosted-dark"\][^{]*\.agent-subagent-popover[^{]*\{/,
    );
  });

  it("frosted-light applies the Apple-HUD glass override to the subagent popover", () => {
    expect(themes).toMatch(
      /html\[data-theme="frosted-light"\]\s+\.agent-subagent-popover\s*\{|html\[data-theme="frosted-light"\][^{]*\.agent-subagent-popover[^{]*\{/,
    );
  });
});
