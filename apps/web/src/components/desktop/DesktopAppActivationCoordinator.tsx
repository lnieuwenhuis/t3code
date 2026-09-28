import {
  createRuntimeCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { probeDesktopEnvironment } from "../../desktopEnvironmentProbe";
import { handleDesktopAppActivationRequest } from "../../desktopAppActivation";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { findProjectByPath, inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newProjectId } from "../../lib/utils";
import { readProjects, waitForProject } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";

const probeEnvironmentCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "desktop:probe-environment",
  execute: (
    request: Extract<DesktopAppActivationRequest, { type: "probe-environment" }>,
    registry,
  ) =>
    probeDesktopEnvironment(request, (environmentId) =>
      registry.get(environmentShell.stateValueAtom(environmentId)),
    ),
});

export function DesktopAppActivationCoordinator() {
  const probeEnvironment = useAtomCommand(probeEnvironmentCommand, {
    reportFailure: false,
    reportDefect: false,
  });
  const primaryEnvironment = usePrimaryEnvironment();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  const shell = useEnvironmentQuery(
    primaryEnvironment === null
      ? null
      : environmentShell.stateAtom(primaryEnvironment.environmentId),
  );
  const ready =
    activation !== undefined &&
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null &&
    shell.data?.snapshot._tag === "Some";

  const processRequest = useEffectEvent(async (request: DesktopAppActivationRequest) => {
    if (request.type === "probe-environment") {
      const result = await probeEnvironment(request);
      return result._tag === "Success"
        ? result.value
        : {
            version: 1 as const,
            requestId: request.requestId,
            ok: false as const,
            code: "environment-unavailable" as const,
            message: "The desktop connection runtime is unavailable.",
          };
    }
    return handleDesktopAppActivationRequest(request, {
      getTarget: () => {
        if (
          primaryEnvironment?.connection.phase !== "connected" ||
          primaryEnvironment.serverConfig === null
        ) {
          return null;
        }
        return {
          environmentId: primaryEnvironment.environmentId,
          platform: primaryEnvironment.serverConfig.environment.platform.os,
        };
      },
      findProject: (environmentId, workspaceRoot) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === environmentId),
          workspaceRoot,
        ) ?? null,
      createProject: async (environmentId, workspaceRoot) => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(workspaceRoot),
            workspaceRoot,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
        }
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      openThread: (projectRef) => openThread(projectRef),
    });
  });

  const reportReady = useEffectEvent(() =>
    activation?.setReady({ workspaceReady: ready }).catch(() => undefined),
  );

  useEffect(() => {
    if (activation === undefined) return;

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current.catch(() => undefined);
    });
    // Skip readiness if React runs cleanup before this subscription can receive requests.
    queueMicrotask(() => {
      if (subscribed) void reportReady();
    });
    return () => {
      subscribed = false;
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [activation]);

  useEffect(() => {
    if (activation !== undefined)
      void activation.setReady({ workspaceReady: ready }).catch(() => undefined);
  }, [activation, ready]);

  return null;
}
