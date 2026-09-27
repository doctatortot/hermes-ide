/**
 * Coverage for the bridge's runtime/lifecycle helpers:
 *
 * - `createIdempotentLatch` — once-only resolver used to mark "first
 *   SDK init event seen".  Multiple `.resolve()` calls must be safe.
 *
 * - `createControlOpBuffer` — buffers control ops (setModel /
 *   setPermissionMode / interrupt) that arrive between bridge startup
 *   and `query()` returning.  Without it, ops sent in that microsecond
 *   window were silently dropped, which surfaced as confusing "the
 *   chip updated but the model didn't" bugs.
 */
import { describe, it, expect, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS module, no .d.ts file
import {
  createIdempotentLatch,
  createControlOpBuffer,
  toSdkUserMessage,
  resolveRuntimeModuleSpecifier,
} from "../../src-tauri/bridge/bridgeRuntimeHelpers.mjs";
import { buildUserEnvelope } from "../utils/submitToAgent";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("../api/agent", () => ({ sendAgentInput: vi.fn() }));

describe("createIdempotentLatch", () => {
  it("resolves the promise on first call", async () => {
    const latch = createIdempotentLatch();
    expect(latch.settled()).toBe(false);
    latch.resolve();
    expect(latch.settled()).toBe(true);
    await expect(latch.promise).resolves.toBeUndefined();
  });

  it("subsequent .resolve() calls are silent no-ops", async () => {
    const latch = createIdempotentLatch();
    latch.resolve();
    latch.resolve();
    latch.resolve();
    expect(latch.settled()).toBe(true);
    await expect(latch.promise).resolves.toBeUndefined();
  });

  it("the promise is awaitable before resolution", async () => {
    const latch = createIdempotentLatch();
    let resolvedAt: number | null = null;
    const waiter = latch.promise.then(() => {
      resolvedAt = Date.now();
    });
    expect(resolvedAt).toBeNull();
    latch.resolve();
    await waiter;
    expect(resolvedAt).not.toBeNull();
  });

  it("two latches are independent", () => {
    const a = createIdempotentLatch();
    const b = createIdempotentLatch();
    a.resolve();
    expect(a.settled()).toBe(true);
    expect(b.settled()).toBe(false);
  });
});

describe("createControlOpBuffer", () => {
  it("buffers ops before markReady() — handler not invoked yet", () => {
    const handler = vi.fn();
    const buf = createControlOpBuffer(handler);
    buf.dispatch({ op: "setModel", model: "opus" });
    buf.dispatch({ op: "interrupt" });
    expect(handler).not.toHaveBeenCalled();
    expect(buf.isReady()).toBe(false);
    expect(buf.pending()).toBe(2);
  });

  it("drains buffered ops in arrival order on markReady()", async () => {
    const calls: unknown[] = [];
    const handler = (op: unknown) => { calls.push(op); };
    const buf = createControlOpBuffer(handler);
    await buf.dispatch({ op: "setModel", model: "opus" });
    await buf.dispatch({ op: "setPermissionMode", mode: "plan" });
    await buf.dispatch({ op: "interrupt" });
    expect(calls).toEqual([]);

    await buf.markReady();
    expect(calls).toEqual([
      { op: "setModel", model: "opus" },
      { op: "setPermissionMode", mode: "plan" },
      { op: "interrupt" },
    ]);
    expect(buf.pending()).toBe(0);
  });

  it("dispatches synchronously after markReady()", async () => {
    const handler = vi.fn();
    const buf = createControlOpBuffer(handler);
    await buf.markReady();
    await buf.dispatch({ op: "setModel", model: "haiku" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ op: "setModel", model: "haiku" });
  });

  it("awaits async handlers in the drain — no concurrent writes", async () => {
    const calls: string[] = [];
    let active = 0;
    let maxConcurrency = 0;
    const handler = async (op: { id: string }) => {
      active++;
      maxConcurrency = Math.max(maxConcurrency, active);
      await new Promise((r) => setTimeout(r, 5));
      calls.push(op.id);
      active--;
    };
    const buf = createControlOpBuffer(handler);
    await buf.dispatch({ id: "first" });
    await buf.dispatch({ id: "second" });
    await buf.dispatch({ id: "third" });
    await buf.markReady();
    // Sequential dispatch — never two at the same time.
    expect(maxConcurrency).toBe(1);
    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("markReady() is idempotent — second call is a no-op", async () => {
    const handler = vi.fn();
    const buf = createControlOpBuffer(handler);
    await buf.dispatch({ op: "setModel", model: "opus" });
    await buf.markReady();
    expect(handler).toHaveBeenCalledTimes(1);
    await buf.markReady();
    await buf.markReady();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isReady() reflects state across the lifecycle", async () => {
    const buf = createControlOpBuffer(() => {});
    expect(buf.isReady()).toBe(false);
    await buf.markReady();
    expect(buf.isReady()).toBe(true);
  });
});

describe("toSdkUserMessage — SDK `origin` provenance", () => {
  it("composer path: a typed message reaches the SDK stamped as human", () => {
    const env = buildUserEnvelope("hello", [])!;
    const msg = toSdkUserMessage(JSON.parse(JSON.stringify(env)), "sid-1");
    expect(msg.origin).toEqual({ kind: "human" });
    expect(msg.message).toEqual(env.message);
    expect(msg.session_id).toBe("sid-1");
    expect(msg.parent_tool_use_id).toBeNull();
  });

  it("injected path: an envelope without origin stays unattributed (never defaulted to human)", () => {
    const injected = {
      type: "user",
      uuid: "u-1",
      message: { role: "user", content: [{ type: "text", text: "injected" }] },
    };
    const msg = toSdkUserMessage(injected, "sid-1");
    expect("origin" in msg).toBe(false);
  });

  it("passes a non-human origin through unchanged", () => {
    const origin = { kind: "peer", from: "other-session" };
    const msg = toSdkUserMessage({ type: "user", message: {}, origin }, undefined);
    expect(msg.origin).toEqual(origin);
    expect("session_id" in msg).toBe(false);
  });
});

/**
 * `resolveRuntimeModuleSpecifier` — picks the `import()` specifier for an
 * npm dep of the bridge (see docs/adr/002-bridge-runtime-tarball.md). In
 * dev there's no `--bridge-runtime-dir`, so it must hand back the bare
 * package name unchanged (Node resolves it from the bridge's own adjacent
 * node_modules, exactly like the static imports it replaced). In
 * production it must read the extracted runtime's manifest.json and
 * build a `file://` URL to the package's recorded entry file — never a
 * guess at a filename, since a package's `exports` map can change shape
 * across versions (the SDK's did, 0.2.x → 0.3.x).
 */
describe("resolveRuntimeModuleSpecifier", () => {
  it("returns the bare package name when no runtime dir is given (dev)", () => {
    const io = {
      readFileSync: vi.fn(),
      pathToFileURL: vi.fn(),
      join: vi.fn(),
    };
    const spec = resolveRuntimeModuleSpecifier(
      "@anthropic-ai/claude-agent-sdk",
      null,
      io,
    );
    expect(spec).toBe("@anthropic-ai/claude-agent-sdk");
    expect(io.readFileSync).not.toHaveBeenCalled();
  });

  it("reads manifest.json and builds a file:// URL from the recorded entry (production)", () => {
    const manifest = {
      entries: { "@anthropic-ai/claude-agent-sdk": "@anthropic-ai/claude-agent-sdk/sdk.mjs" },
    };
    const io = {
      readFileSync: vi.fn((path: string) => {
        expect(path).toBe("/runtime/0.3.283/manifest.json");
        return JSON.stringify(manifest);
      }),
      pathToFileURL: vi.fn((p: string) => ({ href: `file://${p}` })),
      join: vi.fn((...parts: string[]) => parts.join("/")),
    };
    const spec = resolveRuntimeModuleSpecifier(
      "@anthropic-ai/claude-agent-sdk",
      "/runtime/0.3.283",
      io,
    );
    expect(spec).toBe(
      "file:///runtime/0.3.283/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    );
  });

  it("resolves a second package (zod) independently from the same manifest", () => {
    const manifest = {
      entries: {
        "@anthropic-ai/claude-agent-sdk": "@anthropic-ai/claude-agent-sdk/sdk.mjs",
        zod: "zod/index.js",
      },
    };
    const io = {
      readFileSync: vi.fn(() => JSON.stringify(manifest)),
      pathToFileURL: vi.fn((p: string) => ({ href: `file://${p}` })),
      join: vi.fn((...parts: string[]) => parts.join("/")),
    };
    const spec = resolveRuntimeModuleSpecifier("zod", "/runtime/0.3.283", io);
    expect(spec).toBe("file:///runtime/0.3.283/node_modules/zod/index.js");
  });

  it("throws a clear error when the manifest has no entry for the package", () => {
    const io = {
      readFileSync: vi.fn(() => JSON.stringify({ entries: {} })),
      pathToFileURL: vi.fn(),
      join: vi.fn((...parts: string[]) => parts.join("/")),
    };
    expect(() => resolveRuntimeModuleSpecifier("zod", "/runtime/0.3.283", io)).toThrow(
      /no entry for 'zod'/,
    );
  });
});
