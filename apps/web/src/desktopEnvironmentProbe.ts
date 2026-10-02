import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type {
  DesktopAppActivationResponse,
  DesktopAppEnvironmentProbeRequest,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** Proves the renderer's own authenticated session and loaded shell, never a separate connection. */
export function probeDesktopEnvironment(
  request: DesktopAppEnvironmentProbeRequest,
  readShell: (environmentId: EnvironmentId) => EnvironmentShellState,
): Effect.Effect<DesktopAppActivationResponse, never, EnvironmentRegistry.EnvironmentRegistry> {
  const unavailable = (message: string): DesktopAppActivationResponse => ({
    version: 1,
    requestId: request.requestId,
    ok: false,
    code: "environment-unavailable",
    message,
  });
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(request.environmentId);
    if (entry === undefined)
      return unavailable("The requested environment is not saved in this desktop app.");
    if (!entry.enabled) {
      if (request.retry) yield* registry.setEnabled(request.environmentId, true);
      return unavailable("The requested environment is disabled or starting its connection.");
    }
    const state = yield* registry.state(request.environmentId);
    if (state.phase !== "connected") {
      if (request.retry && state.phase !== "connecting")
        yield* registry.retryNow(request.environmentId);
      return unavailable("The requested environment is not connected.");
    }
    return yield* registry.run(
      request.environmentId,
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const session = yield* SubscriptionRef.get(supervisor.session);
        if (Option.isNone(session))
          return unavailable("The requested environment has no authenticated session.");
        const config = yield* session.value.initialConfig;
        if (
          config.environment.environmentId !== request.environmentId ||
          config.environment.orchestrationProtocolVersion !== 2
        )
          return unavailable("The requested environment has an incompatible identity or protocol.");
        yield* session.value.probe;
        const currentSession = yield* SubscriptionRef.get(supervisor.session);
        const currentState = yield* SubscriptionRef.get(supervisor.state);
        if (
          Option.isNone(currentSession) ||
          currentSession.value !== session.value ||
          currentState.phase !== "connected"
        ) {
          return unavailable("The requested environment changed connection during the probe.");
        }
        const shell = readShell(request.environmentId);
        if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
          return unavailable(
            "The requested environment has not loaded its live project and thread snapshot.",
          );
        }
        return {
          version: 1,
          requestId: request.requestId,
          ok: true,
          type: "probe-environment",
          environmentId: request.environmentId,
          serverVersion: config.environment.serverVersion,
          protocolVersion: 2,
          projectCount: shell.snapshot.value.projects.length,
          threadCount: shell.snapshot.value.threads.length,
        } satisfies DesktopAppActivationResponse;
      }),
    );
  }).pipe(
    Effect.timeout("5 seconds"),
    // Keep credentials, transport URLs and server errors out of the local diagnostic reply.
    Effect.catchCause(() =>
      Effect.succeed(
        unavailable("The requested environment did not complete its authenticated probe."),
      ),
    ),
  );
}
