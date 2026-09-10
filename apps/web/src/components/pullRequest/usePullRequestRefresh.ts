import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestDetail, PullRequestRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
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
  refreshActivity,
  refreshDetail,
  forcedRefreshToken,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  scopeKey: string;
  detail: Pick<PullRequestDetail, "updatedAt"> | null;
  refreshMetadata: () => void;
  refreshActivity: () => void;
  refreshDetail: () => void;
  forcedRefreshToken: number;
}) {
  const [refreshToken, setRefreshToken] = useState(0);
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
    // A changed revision must miss the held diff before the Code tab reads its first page.
    // Later revisions or another PR supersede this refresh while invalidation is in flight.
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
      refreshActivity();
      setRefreshToken((token) => token + 1);
    });
  }, [refreshActivity, detail, environmentId, invalidate, reference, scopeKey]);
  // Poll fresh metadata without invalidating cached diff pages. A changed detail revision
  // refreshes activity and the Code tab above; unchanged polls preserve loaded slices.
  const refreshDetailFromHost = useCallback(async () => {
    const result = await invalidate({ environmentId, input: { reference, scope: "detail" } });
    if (result._tag === "Success") refreshMetadata();
  }, [refreshMetadata, environmentId, invalidate, reference]);
  useLiveRefresh(() => void refreshDetailFromHost(), {
    key: `pull-request:${scopeKey}`,
  });
  const [isInvalidating, setIsInvalidating] = useState(false);
  const refreshFromHost = useCallback(async () => {
    setIsInvalidating(true);
    try {
      const result = await invalidate({ environmentId, input: { reference } });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "The pull request could not be refreshed",
          description: readableFailure(squashAtomCommandFailure(result), "Try refreshing again."),
        });
        return;
      }
      refreshDetail();
      setRefreshToken((token) => token + 1);
    } finally {
      setIsInvalidating(false);
    }
  }, [environmentId, invalidate, reference, refreshDetail]);
  // A refresh asked for by the page: the detail, and through the token below, the diff with it.
  const appliedForcedToken = useRef(forcedRefreshToken);
  useEffect(() => {
    if (appliedForcedToken.current === forcedRefreshToken) return;
    appliedForcedToken.current = forcedRefreshToken;
    void refreshFromHost();
  }, [forcedRefreshToken, refreshFromHost]);
  return { refreshToken, isInvalidating, refreshFromHost };
}
