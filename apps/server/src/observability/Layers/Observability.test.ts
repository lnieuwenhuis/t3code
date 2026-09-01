// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import * as BrowserTraceCollector from "../BrowserTraceCollector.ts";
import { ObservabilityLive } from "./Observability.ts";

const makeServerConfigLayer = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return { ...config, ...overrides } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-observability-test-" })),
  );

it.layer(NodeServices.layer)("ObservabilityLive trace export", (it) => {
  it.effect("does not create the trace file directory when tracing is disabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const now = yield* Clock.currentTimeMillis;
      const traceDir = join(NodeOS.tmpdir(), `t3-observability-disabled-${now}`);
      const serverTracePath = join(traceDir, "server.trace.ndjson");

      const configLayer = makeServerConfigLayer({ traceEnabled: false, serverTracePath });

      // Requesting BrowserTraceCollector forces the layer's Layer.unwrap to run, the same
      // point at which the real tracer would create its trace file directory.
      const collector = yield* BrowserTraceCollector.BrowserTraceCollector.pipe(
        Effect.provide(
          ObservabilityLive.pipe(
            Layer.provide(
              Layer.mergeAll(configLayer, ResourceAttribution.layer, FetchHttpClient.layer),
            ),
          ),
        ),
        Effect.scoped,
      );
      yield* collector.record([]);

      const traceDirExists = yield* fs.exists(traceDir);
      assert.equal(traceDirExists, false);
    }),
  );

  it.effect("creates the trace file directory when tracing is enabled (default)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const now = yield* Clock.currentTimeMillis;
      const traceDir = join(NodeOS.tmpdir(), `t3-observability-enabled-${now}`);
      const serverTracePath = join(traceDir, "server.trace.ndjson");

      const configLayer = makeServerConfigLayer({ traceEnabled: true, serverTracePath });

      yield* BrowserTraceCollector.BrowserTraceCollector.pipe(
        Effect.provide(
          ObservabilityLive.pipe(
            Layer.provide(
              Layer.mergeAll(configLayer, ResourceAttribution.layer, FetchHttpClient.layer),
            ),
          ),
        ),
        Effect.scoped,
      );

      const traceDirExists = yield* fs.exists(traceDir);
      assert.equal(traceDirExists, true);

      yield* fs.remove(traceDir, { recursive: true }).pipe(Effect.ignore);
    }),
  );
});
