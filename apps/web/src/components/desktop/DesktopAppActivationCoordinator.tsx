import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { m } from "~/i18n/messages";
import { connectionAtomRuntime } from "../../connection/runtime";
import { probeDesktopEnvironment } from "../../desktopEnvironmentProbe";
import { useOpenLocalWorkspace } from "../../hooks/useOpenLocalWorkspace";
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
  const openLocalWorkspace = useOpenLocalWorkspace();
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  const ready = activation !== undefined && openLocalWorkspace.ready;

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
            message: m(msg("The desktop connection runtime is unavailable.")),
          };
    }
    return openLocalWorkspace.open(request);
  });

  const reportReady = useEffectEvent(() =>
    activation?.setReady({ workspaceReady: ready }).catch(() => undefined),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop activation requests over the bridge and marks the renderer ready
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports workspace readiness to the desktop activation bridge
  useEffect(() => {
    if (activation !== undefined)
      void activation.setReady({ workspaceReady: ready }).catch(() => undefined);
  }, [activation, ready]);

  return null;
}
