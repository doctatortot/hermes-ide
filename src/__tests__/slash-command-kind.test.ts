/**
 * `classifySlashCommand` — pins which CLI commands need an embedded
 * PTY vs which run as a normal stream-json prompt.
 *
 * Priority (in order):
 *   1. `<plugin>:<skill>` namespace → always native.
 *   2. Description with terminal hint ("opens terminal", etc) → cli.
 *   3. Description present + no CLI hint → native (trust the SDK).
 *   4. No description + name in KNOWN_CLI_COMMANDS → cli.
 *   5. Otherwise → native.
 *
 * The priority matters: an SDK-reported skill that happens to share
 * a name with a CLI built-in (e.g. `/init` is both a CLI command and
 * a Conductor skill) MUST classify as native when the SDK provides a
 * description — we trust the SDK's word.
 */
import { describe, it, expect } from "vitest";
import {
  buildSlashItemsFromInit,
  classifySlashCommand,
  missingCliBuiltins,
  resolveSlashCommandKind,
  stripSlash,
} from "../utils/slashCommandKind";

describe("classifySlashCommand — known CLI built-ins (no description)", () => {
  it("interactive-only verbs without an SDK description fall through to cli", () => {
    for (const cmd of [
      "/mcp",
      "/mcp-status",
      "/agents",
      "/help",
      "/cost",
      "/login",
      "/logout",
      "/permissions",
      "/clear",
      "/compact",
      "/config",
      "/doctor",
      "/memory",
      "/model",
      "/recap",
      "/release-notes",
      "/status",
      "/terminal-setup",
      "/vim",
    ]) {
      expect(classifySlashCommand({ command: cmd })).toBe("cli");
    }
  });

  it("classifies regardless of leading slash + case", () => {
    expect(classifySlashCommand({ command: "MCP" })).toBe("cli");
    expect(classifySlashCommand({ command: "/Help" })).toBe("cli");
    expect(classifySlashCommand({ command: "/AGENTS" })).toBe("cli");
  });
});

describe("classifySlashCommand — description trumps the KNOWN list", () => {
  it("a same-named SDK skill (with description, no CLI hint) → native", () => {
    // `/init` is BOTH a CLI built-in and an SDK-reported skill in
    // Conductor's catalog.  When the SDK reports it (i.e. provides
    // a description), we treat it as the skill — running it through
    // stream-json — not the interactive terminal.  This protects
    // user intent: they picked the skill from the popover.
    expect(
      classifySlashCommand({
        command: "/init",
        description: "Initialize a new CLAUDE.md file with codebase docs",
      }),
    ).toBe("native");

    expect(
      classifySlashCommand({
        command: "/recap",
        description: "Summarize the conversation in five bullets",
      }),
    ).toBe("native");
  });

  it("description with CLI hint still wins → cli", () => {
    expect(
      classifySlashCommand({
        command: "/my-tui",
        description: "Drop into an interactive picker (opens terminal)",
      }),
    ).toBe("cli");

    expect(
      classifySlashCommand({
        command: "/my-tool",
        description: "Run an interactive CLI for setup",
      }),
    ).toBe("cli");
  });

  it("description mentioning the word 'terminal' in passing does NOT flip", () => {
    expect(
      classifySlashCommand({
        command: "/explain-terminal",
        description: "Explain what a terminal command does without running it",
      }),
    ).toBe("native");
  });
});

describe("classifySlashCommand — namespaced (skill / plugin)", () => {
  it("/<plugin>:<skill> is always native", () => {
    expect(classifySlashCommand({ command: "/frontend-design:frontend-design" })).toBe("native");
    expect(classifySlashCommand({ command: "/telegram:configure" })).toBe("native");
    expect(classifySlashCommand({ command: "/hermes-test:ping" })).toBe("native");
  });

  it("plugin-namespaced names that look like CLI commands are STILL native", () => {
    expect(classifySlashCommand({ command: "/myplugin:mcp" })).toBe("native");
    expect(classifySlashCommand({ command: "/myplugin:help" })).toBe("native");
  });
});

describe("classifySlashCommand — user / custom commands", () => {
  it("custom commands NOT on the curated list default to native", () => {
    expect(classifySlashCommand({ command: "/ship" })).toBe("native");
    expect(classifySlashCommand({ command: "/hermes-ping" })).toBe("native");
    expect(classifySlashCommand({ command: "/team-standup" })).toBe("native");
  });
});

/* ─── Regression: `/cli-verb <args>` must still classify as cli ────
 *
 * Real bug shipped in the 1.1.x line: typing `/remote-control random`
 * (or any CLI verb followed by arguments) made the classifier extract
 * `remote-control random` as the bare key, miss the curated set, fall
 * through to `native`, and submit the input to Claude as a normal
 * prompt.  Claude's own slash-command handler then refused with
 * "/remote-control isn't available in this environment." because
 * interactive slash commands aren't usable in stream-json mode.
 *
 * Fix: strip trailing arguments before the curated-set lookup.  These
 * tests pin the new behavior across every well-known CLI verb so any
 * regression that re-introduces whitespace-sensitivity is caught at
 * unit-test time on every platform we run CI on (Linux, macOS,
 * Windows). */
describe("classifySlashCommand — CLI verbs with trailing arguments (regression)", () => {
  it("`/remote-control random` classifies as cli, not native", () => {
    expect(classifySlashCommand({ command: "/remote-control random" })).toBe("cli");
  });

  it("preserves the cli classification for arbitrary args on every curated verb", () => {
    // Spot-check a representative slice of the catalog; the classifier
    // is uniform across entries, so this set proves the contract for
    // the whole curated list.
    const cases: Array<[string, string]> = [
      ["/mcp", "list"],
      ["/agents", "create foo"],
      ["/help", "agents"],
      ["/config", "set theme dark"],
      ["/model", "claude-opus-4-7"],
      ["/permissions", "add Read"],
      ["/remote-control", "random"],
      ["/remote-env", "set FOO=bar"],
      ["/cost", "today"],
      ["/recap", "last 5 turns"],
    ];
    for (const [verb, args] of cases) {
      const input = `${verb} ${args}`;
      expect(
        classifySlashCommand({ command: input }),
        `expected ${input} to classify as cli`,
      ).toBe("cli");
    }
  });

  it("multiple-whitespace / tabs between verb and args still classify as cli", () => {
    expect(classifySlashCommand({ command: "/mcp   list" })).toBe("cli");
    expect(classifySlashCommand({ command: "/agents\tcreate" })).toBe("cli");
    expect(classifySlashCommand({ command: "/help\n--verbose" })).toBe("cli");
  });

  it("unknown verb with args still falls through to native", () => {
    // The curated-set lookup must still REJECT unknown verbs even
    // when args are present.  This guards against an over-eager fix
    // that classifies anything-with-args as cli.
    expect(classifySlashCommand({ command: "/ship arg1 arg2" })).toBe("native");
    expect(classifySlashCommand({ command: "/team-standup yesterday" })).toBe("native");
  });

  it("plugin-namespaced commands with args remain native", () => {
    expect(
      classifySlashCommand({ command: "/frontend-design:frontend-design hero" }),
    ).toBe("native");
    expect(classifySlashCommand({ command: "/telegram:configure now" })).toBe("native");
  });
});

describe("missingCliBuiltins — curated-mirror merge", () => {
  it("returns the well-known Claude Code CLI built-ins when none are in the existing list", () => {
    const got = missingCliBuiltins([]);
    const names = got.map((b) => b.command);
    // Spot-check several names across the catalog.
    expect(names).toContain("/mcp");
    expect(names).toContain("/mcp-status");
    expect(names).toContain("/agents");
    expect(names).toContain("/help");
    expect(names).toContain("/cost");
    expect(names).toContain("/login");
    expect(names).toContain("/logout");
    expect(names).toContain("/permissions");
    expect(names).toContain("/plan");
    expect(names).toContain("/plugin");
    expect(names).toContain("/clear");
    expect(names).toContain("/compact");
    expect(names).toContain("/diff");
    expect(names).toContain("/doctor");
    expect(names).toContain("/memory");
    expect(names).toContain("/model");
    expect(names).toContain("/theme");
  });

  it("catalog has at least 60 entries", () => {
    expect(missingCliBuiltins([]).length).toBeGreaterThanOrEqual(60);
  });

  it("dedupes against the SDK-reported list (case-insensitive)", () => {
    const got = missingCliBuiltins([
      { command: "/mcp" },
      { command: "/Help" },
      { command: "/AGENTS" },
    ]);
    const names = got.map((b) => b.command);
    expect(names).not.toContain("/mcp");
    expect(names).not.toContain("/help");
    expect(names).not.toContain("/agents");
    // But still includes the rest.
    expect(names).toContain("/login");
    expect(names).toContain("/cost");
  });

  it("every catalog entry classifies as `cli` when used without a description", () => {
    for (const b of missingCliBuiltins([])) {
      expect(classifySlashCommand({ command: b.command })).toBe("cli");
    }
  });

  it("descriptions are short enough for the dropdown row (≤60 chars)", () => {
    for (const b of missingCliBuiltins([])) {
      expect(b.description.length).toBeLessThanOrEqual(60);
    }
  });
});

describe("stripSlash", () => {
  it("removes a leading slash", () => {
    expect(stripSlash("/mcp")).toBe("mcp");
    expect(stripSlash("/foo:bar")).toBe("foo:bar");
  });
  it("leaves bare names alone", () => {
    expect(stripSlash("mcp")).toBe("mcp");
  });
  it("only strips ONE leading slash (defensive)", () => {
    expect(stripSlash("//mcp")).toBe("/mcp");
  });
});

/* ─── Regression: `/compact` and other SDK-reported natives ─────────
 *
 * Real bug reported by a user in 1.3.0: after the agent session hit
 * "prompt is too long", typing `/compact` showed the embedded-terminal
 * banner instead of sending the command through stream-json.  Root
 * cause: `init.slash_commands` enumerates commands available natively
 * over stream-json, but the SDK reports them as bare strings (no
 * description).  When the SessionComposer built items from init, it
 * left `kind` unset, then re-ran the classifier — which saw an empty
 * description, fell through to KNOWN_CLI_COMMANDS, and stamped
 * `kind: "cli"` on the very commands the SDK said were native.
 *
 * The fix introduces a dedicated builder (`buildSlashItemsFromInit`)
 * that pins SDK-reported entries to `kind: "native"` BEFORE any
 * classifier-based fallback runs, plus a `resolveSlashCommandKind`
 * helper for the submit-time path (user types `/compact<Enter>`
 * without picking from the dropdown).
 *
 * These tests pin both halves of the contract. */
describe("buildSlashItemsFromInit — SDK init.slash_commands routing", () => {
  it("bare-string SDK entries are kind:'native' (NOT classified by KNOWN_CLI_COMMANDS)", () => {
    // The four bare strings the SDK actually emits as of v2.1.x.
    // `compact`/`clear`/`init`/`review` are all in KNOWN_CLI_COMMANDS,
    // which would mis-classify them to "cli" if we ran the classifier.
    const items = buildSlashItemsFromInit(["clear", "compact", "init", "review"]);
    const sdkEntries = items.filter((i) =>
      ["/clear", "/compact", "/init", "/review"].includes(i.command),
    );
    expect(sdkEntries).toHaveLength(4);
    for (const item of sdkEntries) {
      expect(
        item.kind,
        `${item.command} must be native — SDK enumerated it in init.slash_commands`,
      ).toBe("native");
    }
  });

  it("normalizes a missing leading slash", () => {
    const items = buildSlashItemsFromInit(["compact"]);
    const compact = items.find((i) => i.command === "/compact");
    expect(compact).toBeDefined();
  });

  it("preserves an existing leading slash", () => {
    const items = buildSlashItemsFromInit(["/compact"]);
    const compact = items.find((i) => i.command === "/compact");
    expect(compact).toBeDefined();
    expect(items.filter((i) => i.command === "//compact")).toHaveLength(0);
  });

  it("object-form SDK entries preserve description and are native", () => {
    const items = buildSlashItemsFromInit([
      { command: "/compact", description: "Summarize conversation history" },
      { command: "review", description: "Review the diff" },
    ]);
    const compact = items.find((i) => i.command === "/compact")!;
    expect(compact.kind).toBe("native");
    expect(compact.description).toBe("Summarize conversation history");
    const review = items.find((i) => i.command === "/review")!;
    expect(review.kind).toBe("native");
  });

  it("still appends curated CLI builtins missing from the SDK list as kind:'cli'", () => {
    const items = buildSlashItemsFromInit(["compact"]);
    const byCmd = new Map(items.map((i) => [i.command, i]));
    expect(byCmd.get("/compact")?.kind).toBe("native");
    // The curated catalog is still merged in — these commands aren't
    // in the SDK's stream-json list and DO need an embedded terminal.
    expect(byCmd.get("/mcp")?.kind).toBe("cli");
    expect(byCmd.get("/agents")?.kind).toBe("cli");
    expect(byCmd.get("/login")?.kind).toBe("cli");
  });

  it("does NOT duplicate when SDK reports a name also in the curated CLI catalog", () => {
    // `/help` is in KNOWN_CLI_COMMANDS, but if the SDK reports it, the
    // SDK wins — and we must NOT also append a cli-kind duplicate.
    const items = buildSlashItemsFromInit(["help"]);
    const helpEntries = items.filter((i) => i.command === "/help");
    expect(helpEntries).toHaveLength(1);
    expect(helpEntries[0].kind).toBe("native");
  });

  it("falls back to prewarm string list when init.slash_commands is missing", () => {
    const items = buildSlashItemsFromInit(undefined, ["custom-skill"]);
    const custom = items.find((i) => i.command === "/custom-skill");
    expect(custom).toBeDefined();
    // Prewarm-sourced commands run through the classifier — unknown
    // verbs default to native.  Curated CLI builtins (`/mcp`, …) are
    // still appended.
    expect(custom?.kind).toBe("native");
    const mcp = items.find((i) => i.command === "/mcp");
    expect(mcp?.kind).toBe("cli");
  });

  it("empty init.slash_commands STILL appends curated CLI builtins", () => {
    const items = buildSlashItemsFromInit([]);
    expect(items.some((i) => i.command === "/mcp" && i.kind === "cli")).toBe(true);
    expect(items.some((i) => i.command === "/login" && i.kind === "cli")).toBe(true);
  });

  it("never returns an item with undefined kind", () => {
    const items = buildSlashItemsFromInit(["compact", "clear"], ["custom"]);
    for (const item of items) {
      expect(item.kind === "native" || item.kind === "cli").toBe(true);
    }
  });
});

describe("resolveSlashCommandKind — submit-time fallback", () => {
  it("SDK-reported items beat the classifier (typed-not-picked path)", () => {
    // Scenario: user types `/compact<Enter>` without picking from the
    // popover.  classifySlashCommand alone returns "cli"; the resolver
    // must consult the SDK-reported list first and return "native".
    const items = buildSlashItemsFromInit(["compact"]);
    expect(resolveSlashCommandKind("/compact", items)).toBe("native");
  });

  it("ignores trailing arguments when matching against the SDK list", () => {
    const items = buildSlashItemsFromInit(["compact"]);
    expect(resolveSlashCommandKind("/compact some text", items)).toBe("native");
    expect(resolveSlashCommandKind("/compact  ", items)).toBe("native");
  });

  it("is case-insensitive (defensive)", () => {
    const items = buildSlashItemsFromInit(["compact"]);
    expect(resolveSlashCommandKind("/COMPACT", items)).toBe("native");
    expect(resolveSlashCommandKind("/Compact", items)).toBe("native");
  });

  it("falls through to the classifier when SDK didn't list the verb", () => {
    const items = buildSlashItemsFromInit([]);
    // `/mcp` is curated as cli — appears in items as kind:"cli".
    expect(resolveSlashCommandKind("/mcp", items)).toBe("cli");
    expect(resolveSlashCommandKind("/mcp list", items)).toBe("cli");
  });

  it("unknown verb with no SDK match defaults to native", () => {
    const items = buildSlashItemsFromInit([]);
    expect(resolveSlashCommandKind("/ship", items)).toBe("native");
    expect(resolveSlashCommandKind("/team-standup yesterday", items)).toBe("native");
  });

  it("regression: bare-string `compact` from the SDK is ALWAYS native, never cli", () => {
    // Direct pin of the 1.3.0 user-reported bug.  This assertion must
    // never regress: it's the entire reason this PR exists.
    const items = buildSlashItemsFromInit(["clear", "compact", "init", "review"]);
    for (const verb of ["/clear", "/compact", "/init", "/review"]) {
      expect(
        resolveSlashCommandKind(verb, items),
        `${verb} from init.slash_commands must route native`,
      ).toBe("native");
    }
  });
});
