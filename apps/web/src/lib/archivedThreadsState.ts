import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import { type EnvironmentThreadShell, scopeThreadShell } from "@t3tools/client-runtime/state/shell";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

const ARCHIVED_FETCH_TIMEOUT_MS = 5_000;

/** Resolves to `fallback` if `promise` has not settled within `timeoutMs`.
    Environment queries never settle while the environment is connecting or
    in backoff, so callers that must not hang wait a bounded time instead. */
export function settleWithin<T, F>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: F,
): Promise<T | F> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** One-shot fetch of an environment's archived thread shells. The archived
    snapshot atom is only mounted while Settings → Archived is open, so a
    synchronous read can miss; this awaits a fresh result instead, bounded so a
    disconnected environment cannot hang the caller. Returns null on failure or
    timeout so callers can fail soft. */
export async function fetchArchivedThreadShells(
  environmentId: EnvironmentId,
): Promise<ReadonlyArray<EnvironmentThreadShell> | null> {
  const result = await settleWithin(
    executeAtomQuery(appAtomRegistry, archivedSnapshotAtom(environmentId), {
      refresh: true,
      reportDefect: false,
      reportFailure: false,
    }),
    ARCHIVED_FETCH_TIMEOUT_MS,
    null,
  );
  if (result === null || result._tag !== "Success") {
    return null;
  }
  return result.value.threads.map((thread) => scopeThreadShell(environmentId, thread));
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  }, [environmentIds]);

  return {
    ...result,
    refresh,
  };
}
