import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { probeDesktopEnvironment } from "./desktopEnvironmentProbe";

const environmentId = EnvironmentId.make("saved-environment");
const request = {
  version: 1,
  requestId: "probe-1",
  type: "probe-environment",
  environmentId,
} as const;
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Saved",
  httpBaseUrl: "http://localhost",
  wsBaseUrl: "ws://localhost",
});
const liveShell: EnvironmentShellState = {
  status: "live",
  error: Option.none(),
  snapshot: Option.some({
    schemaVersion: 2,
    snapshotSequence: 1,
    projects: [],
    threads: [],
    archivedThreads: [],
  }),
};

function setup(
  options: {
    enabled?: boolean;
    registered?: boolean;
    connected?: boolean;
    protocol?: number;
    configEnvironmentId?: EnvironmentId;
  } = {},
) {
  return Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: options.connected === false ? "backoff" : "connected",
    });
    const probe = vi.fn();
    // Only the identity/version descriptor is read; no RPC client method is used by this diagnostic.
    const config = {
      environment: {
        environmentId: options.configEnvironmentId ?? environmentId,
        serverVersion: "0.0.42",
        orchestrationProtocolVersion: options.protocol ?? 2,
      },
    } as ServerConfig;
    const rpcSession: RpcSession = {
      client: {} as WsRpcProtocolClient,
      initialConfig: Effect.succeed(config),
      ready: Effect.void,
      probe: Effect.sync(() => probe()),
      closed: Effect.never,
      subscribeServerConfig: () => Stream.empty,
    };
    const session = yield* SubscriptionRef.make(Option.some(rpcSession));
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state,
      session,
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const entry: ConnectionCatalogEntry = {
      target,
      enabled: options.enabled ?? true,
      profile: Option.none(),
    };
    const retry = vi.fn();
    const enable = vi.fn();
    const registry = EnvironmentRegistry.EnvironmentRegistry.of({
      entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
        new Map(options.registered === false ? [] : [[environmentId, entry]]),
      ),
      networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
      start: Effect.void,
      register: () => Effect.void,
      registerPlatform: () => Effect.void,
      reconcilePlatform: () => Effect.void,
      remove: () => Effect.void,
      removeRelayEnvironments: () => Effect.void,
      setCompatibility: () => Effect.void,
      setEnabled: (id, enabled) =>
        Effect.sync(() => {
          enable(id, enabled);
        }),
      retryNow: (id) =>
        Effect.sync(() => {
          retry(id);
        }),
      state: () => SubscriptionRef.get(state),
      stateChanges: () => SubscriptionRef.changes(state),
      run: (id, effect) => {
        expect(id).toBe(environmentId);
        return Effect.provideService(
          effect,
          EnvironmentSupervisor.EnvironmentSupervisor,
          supervisor,
        );
      },
      runStream: (_id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_id, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    });
    const shell = vi.fn(() => liveShell);
    const run = (retry = false) =>
      probeDesktopEnvironment({ ...request, retry }, shell).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      );
    return { run, probe, retry, enable, shell, session, rpcSession, state };
  });
}

describe("desktop environment probe", () => {
  it.effect("proves the named renderer session and live snapshot", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      expect(yield* test.run()).toEqual({
        version: 1,
        requestId: request.requestId,
        ok: true,
        type: "probe-environment",
        environmentId,
        serverVersion: "0.0.42",
        protocolVersion: 2,
        projectCount: 0,
        threadCount: 0,
      });
      expect(test.probe).toHaveBeenCalledOnce();
      expect(test.shell).toHaveBeenCalledWith(environmentId);
      expect(test.retry).not.toHaveBeenCalled();
      expect(test.enable).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects a missing target without enabling or retrying another environment", () =>
    Effect.gen(function* () {
      const test = yield* setup({ registered: false });
      expect(yield* test.run(true)).toMatchObject({ ok: false, code: "environment-unavailable" });
      expect(test.retry).not.toHaveBeenCalled();
      expect(test.enable).not.toHaveBeenCalled();
      expect(test.probe).not.toHaveBeenCalled();
    }),
  );

  it.effect("only enables the named disabled environment when explicitly requested", () =>
    Effect.gen(function* () {
      const test = yield* setup({ enabled: false });
      expect(yield* test.run()).toMatchObject({ ok: false });
      expect(test.enable).not.toHaveBeenCalled();
      expect(yield* test.run(true)).toMatchObject({ ok: false });
      expect(test.enable).toHaveBeenCalledExactlyOnceWith(environmentId, true);
      expect(test.probe).not.toHaveBeenCalled();
    }),
  );

  it.effect("retries the named disconnected environment without reporting success", () =>
    Effect.gen(function* () {
      const test = yield* setup({ connected: false });
      expect(yield* test.run()).toMatchObject({ ok: false });
      expect(test.retry).not.toHaveBeenCalled();
      expect(yield* test.run(true)).toMatchObject({ ok: false });
      expect(test.retry).toHaveBeenCalledExactlyOnceWith(environmentId);
    }),
  );

  it.effect.each(["empty", "cached", "synchronizing"] as const)("rejects a %s snapshot", (status) =>
    Effect.gen(function* () {
      const test = yield* setup();
      test.shell.mockReturnValue({ ...liveShell, status });
      expect(yield* test.run()).toMatchObject({ ok: false });
      expect(test.probe).toHaveBeenCalledOnce();
    }),
  );

  it.effect("rejects protocol or identity mismatch before probing", () =>
    Effect.gen(function* () {
      for (const options of [
        { protocol: 1 },
        { configEnvironmentId: EnvironmentId.make("other") },
      ]) {
        const test = yield* setup(options);
        expect(yield* test.run()).toMatchObject({ ok: false });
        expect(test.probe).not.toHaveBeenCalled();
      }
    }),
  );

  it.effect("rejects a replaced session even when its old probe succeeds", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      yield* SubscriptionRef.set(
        test.session,
        Option.some({
          ...test.rpcSession,
          probe: SubscriptionRef.set(test.session, Option.some(test.rpcSession)),
        }),
      );
      expect(yield* test.run()).toMatchObject({ ok: false });
      expect(test.shell).not.toHaveBeenCalled();
    }),
  );

  it.effect("does not expose transport errors or claim success after authentication fails", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      test.probe.mockImplementation(() => {
        throw new Error("secret-transport-url");
      });
      const response = yield* test.run();
      expect(response).toMatchObject({ ok: false });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.stringify(response)).not.toContain("secret-transport-url");
      expect(test.shell).not.toHaveBeenCalled();
    }),
  );
  it.effect("does not restart a connection already in progress", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      yield* SubscriptionRef.update(test.state, (state) => ({
        ...state,
        phase: "connecting" as const,
      }));
      expect(yield* test.run(true)).toMatchObject({ ok: false });
      expect(test.retry).not.toHaveBeenCalled();
    }),
  );

  it.effect("bounds a stalled authenticated probe", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      yield* SubscriptionRef.set(
        test.session,
        Option.some({ ...test.rpcSession, probe: Effect.never }),
      );
      const fiber = yield* test.run().pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        ok: false,
        code: "environment-unavailable",
      });
      expect(test.shell).not.toHaveBeenCalled();
    }),
  );
});
