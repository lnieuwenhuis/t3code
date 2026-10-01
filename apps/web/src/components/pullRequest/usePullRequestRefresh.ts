import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestDetail, PullRequestRef } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import { readableFailure, shouldRefreshPullRequestActivity } from "./pullRequestDetail.logic";

/** Coordinates host invalidation with the mounted panel's metadata, activity and diff reads. */
export function usePullRequestRefresh({
  environmentId,
  reference,
  scopeKey,
  detail,
  refreshMetadata,
  forcedRefreshToken,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  scopeKey: string;
  detail: Pick<PullRequestDetail, "updatedAt"> | null;
  refreshMetadata: () => void;
  forcedRefreshToken: number;
}) {
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const activityRevision = useRef<{ readonly key: string; readonly updatedAt: string } | null>(
    null,
  );
  useEffect(
    () => () => {
      activityRevision.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!detail) {
      activityRevision.current = null;
      return;
    }
    const next = { key: scopeKey, updatedAt: detail.updatedAt };
    if (
      activityRevision.current?.key === next.key &&
      activityRevision.current.updatedAt === next.updatedAt
    )
      return;
    const previous = activityRevision.current;
    const changed = shouldRefreshPullRequestActivity(previous, next);
    activityRevision.current = next;
    if (!changed) return;
    // Full invalidation broadcasts one refresh to mounted metadata, activity and Code readers.
    // A second local refresh would interrupt those reads before they settle.
    void invalidate({ environmentId, input: { reference } }).then((result) => {
      if (activityRevision.current !== next) return;
      if (result._tag === "Failure") {
        activityRevision.current = previous;
        toastManager.add({
          type: "error",
          title: "The pull request could not be refreshed",
          description: readableFailure(squashAtomCommandFailure(result), "Try refreshing again."),
        });
        return;
      }
    });
  }, [detail, environmentId, invalidate, reference, scopeKey]);
  // Poll fresh metadata without invalidating cached diff pages. A changed detail revision
  // refreshes activity and the Code tab above; unchanged polls preserve loaded slices.
  const refreshDetailFromHost = useCallback(async () => {
    const result = await invalidate({ environmentId, input: { reference, scope: "detail" } });
    if (result._tag === "Success") refreshMetadata();
  }, [refreshMetadata, environmentId, invalidate, reference]);
  useLiveRefresh(() => void refreshDetailFromHost(), {
    key: `pull-request:${scopeKey}`,
  });
  const refreshScope = useMemo(() => ({ key: scopeKey }), [scopeKey]);
  const activeRefreshScope = useRef<typeof refreshScope | null>(null);
  const refreshGeneration = useRef(0);
  const [pendingScope, setPendingScope] = useState<typeof refreshScope | null>(null);
  useEffect(() => {
    activeRefreshScope.current = refreshScope;
    return () => {
      activeRefreshScope.current = null;
      refreshGeneration.current += 1;
    };
  }, [refreshScope]);
  const isInvalidating = pendingScope === refreshScope;

  const refreshFromHost = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setPendingScope(refreshScope);
    try {
      const result = await invalidate({ environmentId, input: { reference } });
      if (activeRefreshScope.current !== refreshScope || generation !== refreshGeneration.current)
        return;
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "The pull request could not be refreshed",
          description: readableFailure(squashAtomCommandFailure(result), "Try refreshing again."),
        });
        return;
      }
    } finally {
      if (activeRefreshScope.current === refreshScope && generation === refreshGeneration.current)
        setPendingScope(null);
    }
  }, [environmentId, invalidate, reference, refreshScope]);
  // The page can request the same full invalidation; its broadcast refreshes mounted readers.
  const appliedForcedToken = useRef(forcedRefreshToken);
  useEffect(() => {
    if (appliedForcedToken.current === forcedRefreshToken) return;
    appliedForcedToken.current = forcedRefreshToken;
    void refreshFromHost();
  }, [forcedRefreshToken, refreshFromHost]);
  return { isInvalidating, refreshFromHost };
}
