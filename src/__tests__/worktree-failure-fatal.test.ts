/**
 * Bug 3 regression tests for `worktreeFailureIsFatal` and the per-project
 * worktree-create loop in `SessionContext.createSession`.
 *
 * Symptom (1.2.x agent-mode rollout):
 *   When the user picked a branch in SessionCreator and every selected
 *   worktree failed to create (e.g. branch already checked out
 *   elsewhere, disk full, FS permission error), the createSession flow:
 *     1. Caught every error in the per-project try/catch
 *     2. Pushed messages into a `worktreeErrors` array
 *     3. Dispatched a `hermes:worktree-errors` DOM event (non-blocking)
 *     4. Called `apiCreateSession` anyway, which silently fell back to
 *        the project root because no `session_worktrees` row existed.
 *   Result: the agent booted on the project's current branch with NO
 *   isolation, the user saw an apparently-successful session, and the
 *   tiny error toast (if even rendered) was the only signal something
 *   went wrong.
 *
 * Fix:
 *   When every selected worktree fails (>=1 error, 0 successes) the
 *   flow aborts: it destroys the pre-created TerminalPool entry, emits
 *   `hermes:worktree-errors` with `fatal: true`, and `createSession`
 *   returns null so the caller can show a real failure dialog.
 *   Partial failures (some succeeded, some failed) still proceed — the
 *   surviving projects get isolation, the rest are flagged in the
 *   non-fatal event.
 *
 * These tests pin the decision rule (`worktreeFailureIsFatal`) and the
 * per-project loop behaviour.  The loop body is reproduced here as a
 * pure helper so we don't need to render the SessionProvider — the
 * production code uses the same rule and the same accumulator pattern.
 */
import { describe, it, expect } from "vitest";
import { worktreeFailureIsFatal } from "../state/SessionContext";

describe("Bug 3 — worktreeFailureIsFatal decision rule", () => {
  it("is fatal when at least one error and zero successes", () => {
    expect(worktreeFailureIsFatal({ succeeded: 0, errorCount: 1 })).toBe(true);
    expect(worktreeFailureIsFatal({ succeeded: 0, errorCount: 5 })).toBe(true);
  });

  it("is NOT fatal when at least one success (partial failure)", () => {
    // Half-failed is a soft warning, not an abort: the user still gets
    // isolation on the projects that worked.  Aborting would discard
    // legitimate progress.
    expect(worktreeFailureIsFatal({ succeeded: 1, errorCount: 1 })).toBe(false);
    expect(worktreeFailureIsFatal({ succeeded: 3, errorCount: 2 })).toBe(false);
  });

  it("is NOT fatal when nothing was attempted (legacy no-branch-selection path)", () => {
    // The early-out before this gate skips entirely when there are no
    // branchSelections.  But if that ever changes, the rule itself must
    // treat 0/0 as "nothing to abort about".
    expect(worktreeFailureIsFatal({ succeeded: 0, errorCount: 0 })).toBe(false);
  });

  it("is NOT fatal when there was at least one success and zero errors", () => {
    expect(worktreeFailureIsFatal({ succeeded: 2, errorCount: 0 })).toBe(false);
  });
});

// ─── Per-project loop simulation ────────────────────────────────────
//
// Mirrors the accumulator pattern in SessionContext.createSession.
// Production code's loop walks `opts.projectIds`, looks up
// `branchSelections[projectId]`, attempts `createWorktree`, increments
// `worktreesSucceeded` on success, pushes to `worktreeErrors` on failure.
// At the end it checks `worktreeFailureIsFatal` and either aborts or
// continues.  The helper below is the same shape so the tests below pin
// the production behaviour without rendering React.

interface BranchSel {
  branch: string;
  createNew: boolean;
}
interface WorktreeResult {
  worktreePath: string;
  branchName: string;
  isMainWorktree: boolean;
  isShared?: boolean;
}

async function simulateCreateLoop(
  projectIds: string[],
  branchSelections: Record<string, BranchSel>,
  createWorktree: (sid: string, pid: string, b: string, n: boolean) => Promise<WorktreeResult>,
): Promise<{ succeeded: number; errors: string[]; sharedBranches: string[] }> {
  const sharedBranches: string[] = [];
  const errors: string[] = [];
  let succeeded = 0;
  for (const projectId of projectIds) {
    const sel = branchSelections[projectId];
    if (!sel) continue;
    try {
      const wt = await createWorktree("sid", projectId, sel.branch, sel.createNew);
      if (wt.isShared) sharedBranches.push(sel.branch);
      succeeded++;
    } catch (e) {
      errors.push(`${projectId}: ${e}`);
    }
  }
  return { succeeded, errors, sharedBranches };
}

describe("Bug 3 — per-project create loop accumulator", () => {
  it("counts successes and failures independently", async () => {
    let n = 0;
    const create = vi.fn(async () => {
      n++;
      if (n === 2) throw new Error("checkout failed");
      return { worktreePath: `/wt-${n}`, branchName: "x", isMainWorktree: false };
    });
    const result = await simulateCreateLoop(
      ["p1", "p2", "p3"],
      {
        p1: { branch: "x", createNew: false },
        p2: { branch: "y", createNew: false },
        p3: { branch: "z", createNew: false },
      },
      create,
    );
    expect(result.succeeded).toBe(2);
    expect(result.errors).toEqual([expect.stringContaining("p2:")]);
    // → 2 successes, 1 error → NOT fatal → session proceeds.
    expect(worktreeFailureIsFatal({ succeeded: result.succeeded, errorCount: result.errors.length })).toBe(false);
  });

  it("classifies every-worktree-failed as fatal (the bug we shipped)", async () => {
    const create = vi.fn(async () => {
      throw new Error("branch in use by another session");
    });
    const result = await simulateCreateLoop(
      ["p1", "p2"],
      {
        p1: { branch: "feature", createNew: false },
        p2: { branch: "main", createNew: false },
      },
      create,
    );
    expect(result.succeeded).toBe(0);
    expect(result.errors).toHaveLength(2);
    // → 0 successes, 2 errors → FATAL → createSession must abort.
    expect(worktreeFailureIsFatal({ succeeded: result.succeeded, errorCount: result.errors.length })).toBe(true);
  });

  it("skips projects without a branch selection (legacy path)", async () => {
    const create = vi.fn(async () => ({
      worktreePath: "/wt", branchName: "main", isMainWorktree: false,
    }));
    const result = await simulateCreateLoop(
      ["p1", "p2", "p3"],
      { p2: { branch: "main", createNew: false } },
      create,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("collects shared-branch warnings (isShared=true) separately from errors", async () => {
    const create = vi.fn(async (_sid: string, pid: string) => ({
      worktreePath: `/wt-${pid}`,
      branchName: "main",
      isMainWorktree: false,
      isShared: pid === "p1",
    }));
    const result = await simulateCreateLoop(
      ["p1", "p2"],
      {
        p1: { branch: "main", createNew: false },
        p2: { branch: "main", createNew: false },
      },
      create,
    );
    expect(result.succeeded).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.sharedBranches).toEqual(["main"]);
  });
});

// vi import shim
import { vi } from "vitest";
