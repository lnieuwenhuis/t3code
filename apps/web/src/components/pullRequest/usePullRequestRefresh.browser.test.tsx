import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render as renderUi } from "../../../test/render";

const { invalidate, notify } = vi.hoisted(() => ({ invalidate: vi.fn(), notify: vi.fn() }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { invalidate: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => invalidate }));
vi.mock("../ui/toast", () => ({ toastManager: { add: notify } }));

import { usePullRequestRefresh } from "./usePullRequestRefresh";

type Props = Parameters<typeof usePullRequestRefresh>[0];
let testNumber = 0;

function PanelReads(input: Props) {
  const { refreshToken, isInvalidating, refreshFromHost } = usePullRequestRefresh(input);
  return (
    <>
      <output>{refreshToken}</output>
      <button disabled={isInvalidating} onClick={refreshFromHost}>
        Refresh
      </button>
    </>
  );
}

function invalidation() {
  let resolve!: (result: AtomCommandResult<void, Error>) => void;
  const promise = new Promise<AtomCommandResult<void, Error>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  invalidate.mockReturnValueOnce(promise);
  return {
    succeed: () => act(async () => resolve(AsyncResult.success(undefined))),
    fail: () => act(async () => resolve(AsyncResult.failure(Cause.fail(new Error("offline"))))),
  };
}

async function poll() {
  await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
}

async function mountPanel() {
  const timers = fakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const refreshMetadata = vi.fn();
  const refreshActivity = vi.fn();
  const refreshDetail = vi.fn();
  invalidate.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  notify.mockReset();

  let props: Props = {
    environmentId: EnvironmentId.make("environment"),
    reference: {
      projectId: ProjectId.make("project"),
      host: "github.com",
      repository: "acme/web",
      number: 7,
    },
    scopeKey: `environment:project:github.com:acme/web#7:test-${++testNumber}`,
    detail: { updatedAt: "2026-09-10T10:00:00Z" },
    refreshMetadata,
    refreshActivity,
    refreshDetail,
    forcedRefreshToken: 0,
  };

  const screen = await renderUi(
    <StrictMode>
      <PanelReads {...props} />
    </StrictMode>,
    { router: false },
  );

  let mounted = true;
  const rerender = async (changes: Partial<Props> = {}) => {
    props = { ...props, ...changes };
    await screen.rerender(
      <StrictMode>
        <PanelReads {...props} />
      </StrictMode>,
    );
  };
  const unmount = async () => {
    mounted = false;
    await screen.unmount();
  };

  return {
    get props() {
      return props;
    },
    get mounted() {
      return mounted;
    },
    container: screen.container,
    refreshMetadata,
    refreshActivity,
    refreshDetail,
    diffRefreshes: () => screen.container.querySelector("output")!.textContent,
    rerender,
    unmount,
    async [Symbol.asyncDispose]() {
      try {
        await screen[Symbol.asyncDispose]();
      } finally {
        visibility.mockRestore();
        timers[Symbol.dispose]();
      }
    },
  };
}

describe("mounted pull request refresh sequencing", () => {
  it("waits for an existing activity read before refreshing a changed revision", async () => {
    await using panel = await mountPanel();
    await panel.rerender({
      detail: { updatedAt: "2026-09-10T11:00:00Z" },
      activityIsPending: true,
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(panel.refreshActivity).not.toHaveBeenCalled();
    await panel.rerender({ activityIsPending: false });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(panel.refreshActivity).toHaveBeenCalledOnce();
    expect(panel.diffRefreshes()).toBe("1");
  });

  it("awaits detail-only poll invalidation and preserves activity and diff for unchanged metadata", async () => {
    await using panel = await mountPanel();
    expect(invalidate).not.toHaveBeenCalled();
    const pending = invalidation();
    await poll();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      environmentId: panel.props.environmentId,
      input: { reference: panel.props.reference, scope: "detail" },
    });
    expect(panel.refreshMetadata).not.toHaveBeenCalled();
    expect(panel.refreshActivity).not.toHaveBeenCalled();
    expect(panel.diffRefreshes()).toBe("0");
    await pending.succeed();
    expect(panel.refreshMetadata).toHaveBeenCalledOnce();
    await panel.rerender({ detail: { ...panel.props.detail! } });
    expect(panel.refreshActivity).not.toHaveBeenCalled();
    expect(panel.diffRefreshes()).toBe("0");
  });

  it("awaits full invalidation of a polled revision before refreshing activity and the diff", async () => {
    await using panel = await mountPanel();
    await poll();
    expect(panel.refreshMetadata).toHaveBeenCalledOnce();
    const pending = invalidation();
    await panel.rerender({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    expect(invalidate).toHaveBeenLastCalledWith({
      environmentId: panel.props.environmentId,
      input: { reference: panel.props.reference },
    });
    expect(panel.refreshActivity).not.toHaveBeenCalled();
    expect(panel.diffRefreshes()).toBe("0");
    await pending.succeed();
    expect(panel.refreshActivity).toHaveBeenCalledOnce();
    expect(panel.diffRefreshes()).toBe("1");
  });

  it("ignores a completed invalidation superseded by a newer revision", async () => {
    await using panel = await mountPanel();
    const earlier = invalidation();
    await panel.rerender({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    const latest = invalidation();
    await panel.rerender({ detail: { updatedAt: "2026-09-10T10:02:00Z" } });
    await earlier.succeed();
    expect(panel.refreshActivity).not.toHaveBeenCalled();
    expect(panel.diffRefreshes()).toBe("0");
    await latest.succeed();
    expect(panel.refreshActivity).toHaveBeenCalledOnce();
    expect(panel.diffRefreshes()).toBe("1");
  });

  it("ignores a revision invalidation after selecting another pull request", async () => {
    await using panel = await mountPanel();
    const pending = invalidation();
    await panel.rerender({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    await panel.rerender({
      reference: { ...panel.props.reference, number: 8 },
      scopeKey: `${panel.props.scopeKey}:other`,
    });
    await pending.succeed();
    expect(panel.refreshActivity).not.toHaveBeenCalled();
    expect(panel.diffRefreshes()).toBe("0");
  });

  it("does not refresh activity after the panel unmounts during invalidation", async () => {
    await using panel = await mountPanel();
    const pending = invalidation();
    await panel.rerender({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    await panel.unmount();
    await pending.succeed();
    expect(panel.refreshActivity).not.toHaveBeenCalled();
  });

  it("keeps activity and diff on failed revision invalidation and retries on the next metadata result", async () => {
    await using panel = await mountPanel();
    const pending = invalidation();
    await panel.rerender({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    await pending.fail();
    expect(panel.refreshActivity).not.toHaveBeenCalled();
    expect(panel.diffRefreshes()).toBe("0");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    await panel.rerender({ detail: { ...panel.props.detail! } });
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(panel.refreshActivity).toHaveBeenCalledOnce();
    expect(panel.diffRefreshes()).toBe("1");
  });

  it("does not reread held metadata when poll invalidation fails", async () => {
    await using panel = await mountPanel();
    const pending = invalidation();
    await poll();
    await pending.fail();
    expect(panel.refreshMetadata).not.toHaveBeenCalled();
    expect(panel.refreshActivity).not.toHaveBeenCalled();
    expect(panel.diffRefreshes()).toBe("0");
  });

  it("reports failed manual invalidation without refreshing and allows a successful retry", async () => {
    await using panel = await mountPanel();
    const failed = invalidation();
    await act(async () => {
      void panel.container.querySelector("button")!.click();
    });
    expect(panel.container.querySelector("button")!.disabled).toBe(true);
    expect(panel.refreshDetail).not.toHaveBeenCalled();
    await failed.fail();
    expect(panel.refreshDetail).not.toHaveBeenCalled();
    expect(panel.diffRefreshes()).toBe("0");
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "The pull request could not be refreshed",
      description: "offline",
    });
    expect(panel.container.querySelector("button")!.disabled).toBe(false);

    const retry = invalidation();
    await act(async () => {
      void panel.container.querySelector("button")!.click();
    });
    expect(panel.container.querySelector("button")!.disabled).toBe(true);
    expect(panel.refreshDetail).not.toHaveBeenCalled();
    expect(panel.diffRefreshes()).toBe("0");
    await retry.succeed();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(panel.refreshDetail).toHaveBeenCalledOnce();
    expect(panel.diffRefreshes()).toBe("1");
    expect(notify).toHaveBeenCalledOnce();
    expect(panel.container.querySelector("button")!.disabled).toBe(false);
  });

  it.each(["success", "failure"])(
    "ignores an older manual %s while a forced refresh is pending",
    async (outcome) => {
      await using panel = await mountPanel();
      const older = invalidation();
      await act(async () => {
        void panel.container.querySelector("button")!.click();
      });
      const newer = invalidation();
      await panel.rerender({ forcedRefreshToken: 1 });
      await (outcome === "success" ? older.succeed() : older.fail());
      expect(panel.container.querySelector("button")!.disabled).toBe(true);
      expect(panel.refreshDetail).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(panel.diffRefreshes()).toBe("0");
      await newer.succeed();
      expect(panel.container.querySelector("button")!.disabled).toBe(false);
      expect(panel.refreshDetail).toHaveBeenCalledOnce();
      expect(panel.diffRefreshes()).toBe("1");
    },
  );

  it.each(["scope", "unmount"])("ignores a manual refresh after %s changes", async (change) => {
    await using panel = await mountPanel();
    const pending = invalidation();
    await act(async () => {
      void panel.container.querySelector("button")!.click();
    });
    if (change === "scope") {
      await panel.rerender({
        scopeKey: `${panel.props.scopeKey}:other`,
        reference: { ...panel.props.reference, number: 8 },
      });
      expect(panel.container.querySelector("button")!.disabled).toBe(false);
    } else {
      await panel.unmount();
    }
    await pending.succeed();
    expect(panel.refreshDetail).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    if (panel.mounted) expect(panel.diffRefreshes()).toBe("0");
  });

  it("awaits full invalidation before a page refresh", async () => {
    await using panel = await mountPanel();
    const pending = invalidation();
    await panel.rerender({ forcedRefreshToken: 1 });
    expect(panel.refreshDetail).not.toHaveBeenCalled();
    expect(panel.diffRefreshes()).toBe("0");
    expect(panel.container.querySelector("button")!.disabled).toBe(true);
    await pending.succeed();
    expect(panel.refreshDetail).toHaveBeenCalledOnce();
    expect(panel.diffRefreshes()).toBe("1");
    expect(panel.container.querySelector("button")!.disabled).toBe(false);
  });
});
