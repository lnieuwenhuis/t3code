import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { navigateAfterThreadDeletion, resolveThreadDeleteTarget } from "./useThreadActions";
import { toastManager } from "../components/ui/toast";

describe("navigateAfterThreadDeletion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
  });
});

describe("resolveThreadDeleteTarget", () => {
  const target: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
  };
  const activeThread = { id: ThreadId.make("thread-1"), title: "active-thread" };
  const archivedThread = { id: ThreadId.make("thread-1"), title: "archived-thread" };

  it("uses the active-store resolution when it hits, without fetching", async () => {
    const fetchArchived = () => {
      throw new Error("must not fetch the archived snapshot when the active store hits");
    };
    const result = await resolveThreadDeleteTarget({
      target,
      resolveActive: () => ({ thread: activeThread, threadRef: target }),
      fetchArchived,
    });

    expect(result).toEqual({ thread: activeThread, threadRef: target });
  });

  it("falls back to a live fetch and resolves the thread when the fetch finds it (t3code#9085)", async () => {
    // Archived threads are excluded from the main shell store
    // (`listActiveThreadRows`), so deleting one from Settings → Archived
    // must still resolve a thread — otherwise the worktree-cleanup path in
    // deleteThread never runs and the worktree is silently orphaned. There's
    // no synchronous archived cache to try first (it's only warm while the
    // archived panel is open), so this must always be a live fetch.
    const result = await resolveThreadDeleteTarget({
      target,
      resolveActive: () => null,
      fetchArchived: async () => [archivedThread],
    });

    expect(result).toEqual({
      thread: archivedThread,
      threadRef: target,
      archivedThreads: [archivedThread],
    });
  });

  it("returns null when the fetch succeeds but the thread isn't in it", async () => {
    const result = await resolveThreadDeleteTarget({
      target,
      resolveActive: () => null,
      fetchArchived: async () => [],
    });

    expect(result).toBeNull();
  });

  it("fails soft to null when the fetch errors (e.g. offline), instead of blocking the delete", async () => {
    const result = await resolveThreadDeleteTarget({
      target,
      resolveActive: () => null,
      fetchArchived: async () => null,
    });

    expect(result).toBeNull();
  });
});
