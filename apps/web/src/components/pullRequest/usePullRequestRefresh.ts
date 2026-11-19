import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestDetail, PullRequestRef } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { m } from "~/i18n/messages";
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
  activityIsPending = false,
  refreshDetail,
  forcedRefreshToken,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  scopeKey: string;
  detail: Pick<PullRequestDetail, "updatedAt"> | null;
  refreshMetadata: () => void;
  refreshActivity: () => void;
  activityIsPending?: boolean;
  refreshDetail: () => void;
  forcedRefreshToken: number;
}) {
  const [refreshToken, setRefreshToken] = useState(0);
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const activityRevision = useRef<{ readonly key: string; readonly updatedAt: string } | null>(
    null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retires in-flight activity invalidations when the panel unmounts
  useEffect(
    () => () => {
      activityRevision.current = null;
    },
    [],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- invalidates the host's cached activity and diff when the mounted panel sees a new detail revision
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
    // Let an in-flight activity read settle before revalidating its revision.
    if (changed && activityIsPending) return;
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
          title: m(msg("The pull request could not be refreshed")),
          description: readableFailure(
            squashAtomCommandFailure(result),
            m(msg("Try refreshing again.")),
          ),
        });
        return;
      }
      refreshActivity();
      setRefreshToken((token) => token + 1);
    });
  }, [activityIsPending, refreshActivity, detail, environmentId, invalidate, reference, scopeKey]);
  // Poll fresh metadata without invalidating cached diff pages. A changed detail revision
  // refreshes activity and the Code tab above; unchanged polls preserve loaded slices.
  const refreshDetailFromHost = async () => {
    const result = await invalidate({ environmentId, input: { reference, scope: "detail" } });
    if (result._tag === "Success") refreshMetadata();
  };
  useLiveRefresh(() => void refreshDetailFromHost(), {
    key: `pull-request:${scopeKey}`,
  });
  const [refreshScope, setRefreshScope] = useState(() => ({ key: scopeKey }));
  if (refreshScope.key !== scopeKey) setRefreshScope({ key: scopeKey });
  const activeRefreshScope = useRef<typeof refreshScope | null>(null);
  const refreshGeneration = useRef(0);
  const [pendingScope, setPendingScope] = useState<typeof refreshScope | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retires host invalidations when their pull request leaves the mounted panel
  useEffect(() => {
    activeRefreshScope.current = refreshScope;
    return () => {
      activeRefreshScope.current = null;
      refreshGeneration.current += 1;
    };
  }, [refreshScope]);
  const isInvalidating = pendingScope === refreshScope;

  const refetchFromHost = async () => {
    const generation = ++refreshGeneration.current;
    setPendingScope(refreshScope);
    return invalidate({ environmentId, input: { reference } })
      .then((result) => {
        if (activeRefreshScope.current !== refreshScope || generation !== refreshGeneration.current)
          return false;
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: m(msg("The pull request could not be refreshed")),
            description: readableFailure(
              squashAtomCommandFailure(result),
              m(msg("Try refreshing again.")),
            ),
          });
          return false;
        }
        refreshDetail();
        setRefreshToken((token) => token + 1);
        return true;
      })
      .finally(() => {
        if (activeRefreshScope.current === refreshScope && generation === refreshGeneration.current)
          setPendingScope(null);
      });
  };
  const refreshFromHost = async () => {
    await refetchFromHost();
  };
  const applyForcedRefresh = useEffectEvent(() => {
    void refreshFromHost();
  });
  // A refresh asked for by the page: the detail, and through the token below, the diff with it.
  const appliedForcedToken = useRef(forcedRefreshToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forwards the page's refresh request to the host cache for the mounted pull request
  useEffect(() => {
    if (appliedForcedToken.current === forcedRefreshToken) return;
    appliedForcedToken.current = forcedRefreshToken;
    applyForcedRefresh();
  }, [forcedRefreshToken]);
  return { refreshToken, isInvalidating, refreshFromHost, refetchFromHost };
}
