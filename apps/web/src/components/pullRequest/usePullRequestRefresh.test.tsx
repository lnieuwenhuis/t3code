import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { invalidate, notify } = vi.hoisted(() => ({ invalidate: vi.fn(), notify: vi.fn() }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: { invalidate: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => invalidate }));
vi.mock("../ui/toast", () => ({ toastManager: { add: notify } }));

import { LIVE_REFRESH_INTERVAL_MS } from "~/hooks/useLiveRefresh";
import { usePullRequestRefresh } from "./usePullRequestRefresh";

type Props = Parameters<typeof usePullRequestRefresh>[0];
const refreshMetadata = vi.fn();
let renderer: ReactTestRenderer | null;
let props: Props;
let testNumber = 0;

function PanelReads(input: Props) {
  const { isInvalidating, refreshFromHost } = usePullRequestRefresh(input);
  return (
    <>
      <button disabled={isInvalidating} onClick={refreshFromHost}>
        Refresh
      </button>
    </>
  );
}

async function render(changes: Partial<Props> = {}) {
  props = { ...props, ...changes };
  await act(async () => {
    const panel = (
      <StrictMode>
        <PanelReads {...props} />
      </StrictMode>
    );
    if (renderer) renderer.update(panel);
    else renderer = create(panel);
  });
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
  await act(async () => vi.advanceTimersByTimeAsync(LIVE_REFRESH_INTERVAL_MS));
}

beforeEach(() => {
  renderer = null;
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  invalidate.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  notify.mockReset();
  refreshMetadata.mockReset();
  props = {
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
    forcedRefreshToken: 0,
  };
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mounted pull request refresh sequencing", () => {
  it("awaits detail-only poll invalidation before refreshing metadata", async () => {
    await render();
    expect(invalidate).not.toHaveBeenCalled();
    const pending = invalidation();
    await poll();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      environmentId: props.environmentId,
      input: { reference: props.reference, scope: "detail" },
    });
    expect(refreshMetadata).not.toHaveBeenCalled();
    await pending.succeed();
    expect(refreshMetadata).toHaveBeenCalledOnce();
    await render({ detail: { ...props.detail! } });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("invalidates a changed polled revision once without an extra metadata read", async () => {
    await render();
    await poll();
    expect(refreshMetadata).toHaveBeenCalledOnce();
    const pending = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    expect(invalidate).toHaveBeenLastCalledWith({
      environmentId: props.environmentId,
      input: { reference: props.reference },
    });
    await pending.succeed();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(refreshMetadata).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it("ignores a completed invalidation superseded by a newer revision", async () => {
    await render();
    const earlier = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    const latest = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:02:00Z" } });
    await earlier.fail();
    await latest.succeed();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
    await render({ detail: { ...props.detail! } });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("ignores a revision invalidation after selecting another pull request", async () => {
    await render();
    const pending = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    await render({
      reference: { ...props.reference, number: 8 },
      scopeKey: `${props.scopeKey}:other`,
    });
    await pending.fail();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not handle invalidation completion after the panel unmounts", async () => {
    await render();
    const pending = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    await act(async () => renderer!.unmount());
    renderer = null;
    await pending.fail();
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports failed revision invalidation and retries on the next metadata result", async () => {
    await render();
    const pending = invalidation();
    await render({ detail: { updatedAt: "2026-09-10T10:01:00Z" } });
    await pending.fail();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    await render({ detail: { ...props.detail! } });
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(refreshMetadata).not.toHaveBeenCalled();
  });

  it("does not reread held metadata when poll invalidation fails", async () => {
    await render();
    const pending = invalidation();
    await poll();
    await pending.fail();
    expect(refreshMetadata).not.toHaveBeenCalled();
  });

  it("reports failed manual invalidation and allows a successful retry", async () => {
    await render();
    const failed = invalidation();
    await act(async () => {
      void renderer!.root.findByType("button").props.onClick();
    });
    expect(renderer!.root.findByType("button").props.disabled).toBe(true);
    await failed.fail();
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "The pull request could not be refreshed",
      description: "offline",
    });
    expect(renderer!.root.findByType("button").props.disabled).toBe(false);

    const retry = invalidation();
    await act(async () => {
      void renderer!.root.findByType("button").props.onClick();
    });
    expect(renderer!.root.findByType("button").props.disabled).toBe(true);
    await retry.succeed();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(refreshMetadata).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  });

  it.each(["success", "failure"])(
    "ignores an older manual %s while a forced refresh is pending",
    async (outcome) => {
      await render();
      const older = invalidation();
      await act(async () => {
        void renderer!.root.findByType("button").props.onClick();
      });
      const newer = invalidation();
      await render({ forcedRefreshToken: 1 });
      await (outcome === "success" ? older.succeed() : older.fail());
      expect(renderer!.root.findByType("button").props.disabled).toBe(true);
      expect(notify).not.toHaveBeenCalled();
      await newer.succeed();
      expect(refreshMetadata).not.toHaveBeenCalled();
      expect(renderer!.root.findByType("button").props.disabled).toBe(false);
    },
  );

  it.each(["scope", "unmount"])("ignores a manual refresh after %s changes", async (change) => {
    await render();
    const pending = invalidation();
    await act(async () => {
      void renderer!.root.findByType("button").props.onClick();
    });
    if (change === "scope") {
      await render({
        scopeKey: `${props.scopeKey}:other`,
        reference: { ...props.reference, number: 8 },
      });
      expect(renderer!.root.findByType("button").props.disabled).toBe(false);
    } else {
      await act(async () => renderer!.unmount());
      renderer = null;
    }
    await pending.succeed();
    expect(refreshMetadata).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("awaits full invalidation for a page refresh", async () => {
    await render();
    const pending = invalidation();
    await render({ forcedRefreshToken: 1 });
    expect(renderer!.root.findByType("button").props.disabled).toBe(true);
    await pending.succeed();
    expect(renderer!.root.findByType("button").props.disabled).toBe(false);
    expect(refreshMetadata).not.toHaveBeenCalled();
  });
});
