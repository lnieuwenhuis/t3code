// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Layers/Sqlite.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

const seedForkMigrations = Effect.fn("seedForkMigrations")(function* (through: 52 | 53 | 54) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 52 });
  if (through >= 53) {
    yield* sql`CREATE INDEX idx_projection_turns_assistant_message_id
      ON projection_turns(assistant_message_id) WHERE assistant_message_id IS NOT NULL`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (53, 'ProjectionTurnsAssistantMessageIndex')`;
  }
  if (through === 54) {
    yield* PullRequestFilesViewed;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (54, 'PullRequestFilesViewed')`;
    yield* sql`INSERT INTO pull_request_files_viewed
      VALUES ('github', 'github.com', 'owner/repo', 7, 'reader', 'src/example.ts', 'revision', '2026-01-01')`;
  }
});

for (const through of [52, 53, 54] as const) {
  it.effect(
    `snapshots V1 through ${through}, imports transcripts lazily, and preserves both databases across switches`,
    () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v1-v2-"));
      const sourcePath = NodePath.join(directory, "state.sqlite");
      const destinationPath = NodePath.join(directory, "statev2.sqlite");
      const threadId = ThreadId.make("legacy-thread");
      const seed = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedForkMigrations(through);
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'project', 'V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        for (let index = 0; index < 6; index++) {
          yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`message-${index}`}, ${threadId}, ${index % 2 ? "assistant" : "user"}, ${`Text ${index}`}, 0, ${`2026-01-0${index + 1}T00:00:00.000Z`}, ${`2026-01-0${index + 1}T00:00:00.000Z`})`;
        }
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

      return Effect.gen(function* () {
        yield* seed;
        const original = NodeFS.readFileSync(sourcePath);
        const config = yield* ServerConfig.ServerConfig;
        const databaseLayer = SqlitePersistence.layerConfig.pipe(
          Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
        );
        const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
          Layer.provideMerge(databaseLayer),
        );
        const sink = EventSink.layer.pipe(Layer.provide(stores));
        const importer = LegacyV1ThreadImporter.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(stores, sink)),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const history = yield* sql<{ migration_id: number; name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
          assert.deepEqual(
            history.map((row) => [row.migration_id, row.name]),
            migrationManifest.map(([id, name]) => [id, name]),
          );
          const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
          assert.isTrue(columns.some((column) => column.name === "auto_settle_disabled_at"));
          if (through === 54) {
            const viewed = yield* sql`SELECT * FROM pull_request_files_viewed`;
            assert.deepEqual(viewed, [
              {
                provider: "github",
                host: "github.com",
                repository: "owner/repo",
                number: 7,
                viewer: "reader",
                path: "src/example.ts",
                revision: "revision",
                viewed_at: "2026-01-01",
              },
            ]);
          }
          const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          yield* legacy.reconcileShells;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const shell = yield* projections.getThreadProjection(threadId);
          assert.equal(shell.thread.id, threadId);
          assert.deepEqual(
            shell.messages.map((message) => message.text),
            ["Text 4", "Text 5"],
          );
          const pending =
            yield* sql`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports`;
          assert.equal(pending[0]?.transcript_imported_at, null);
          yield* legacy.ensureTranscript(threadId);
          const transcript = yield* projections.getThreadProjection(threadId);
          assert.deepEqual(
            transcript.messages.map((message) => message.text),
            ["Text 0", "Text 1", "Text 2", "Text 3", "Text 4", "Text 5"],
          );
          const imported =
            yield* sql`SELECT imported_message_count, transcript_imported_at FROM orchestration_v2_legacy_imports`;
          assert.equal(imported[0]?.imported_message_count, 6);
          assert.isNotNull(imported[0]?.transcript_imported_at);
          yield* sql`CREATE TABLE v2_work (text TEXT)`;
          yield* sql`INSERT INTO v2_work VALUES ('Keep V2 work')`;
        }).pipe(Effect.provide(importer));
        assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
        const initialized = NodeFS.readFileSync(destinationPath);
        yield* initializeV2Database(destinationPath);
        assert.deepEqual(NodeFS.readFileSync(destinationPath), initialized);
        const v1 = new NodeSqlite.DatabaseSync(sourcePath);
        try {
          assert.equal(
            v1.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
            through,
          );
          assert.equal(
            v1
              .prepare(
                "SELECT count(*) AS count FROM sqlite_master WHERE name = 'orchestration_v2_legacy_imports'",
              )
              .get()?.count,
            0,
          );
          v1.exec("UPDATE projection_threads SET title = 'Continued in V1'");
        } finally {
          v1.close();
        }
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "Keep V2 work");
          assert.equal((yield* sql`SELECT title FROM projection_threads`)[0]?.title, "V1 thread");
        }).pipe(Effect.provide(databaseLayer));
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        ),
      );
    },
  );
}

it.effect("includes committed WAL data and does not publish a failed snapshot", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-snapshot-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  return Effect.gen(function* () {
    NodeFS.writeFileSync(sourcePath, "invalid SQLite");
    assert.isTrue((yield* Effect.result(initializeV2Database(destinationPath)))._tag === "Failure");
    assert.isFalse(NodeFS.existsSync(destinationPath));
    NodeFS.unlinkSync(sourcePath);
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('committed'); BEGIN; INSERT INTO messages VALUES ('uncommitted');",
      );
      yield* initializeV2Database(destinationPath);
      const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
      try {
        assert.deepEqual(
          copy
            .prepare("SELECT text FROM messages")
            .all()
            .map((row) => row.text),
          ["committed"],
        );
      } finally {
        copy.close();
      }
      source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("uses statev2.sqlite for default and explicit development paths", () =>
  Effect.gen(function* () {
    for (const devUrl of [undefined, new URL("http://localhost:5173")]) {
      for (const baseDirIsExplicit of [false, true]) {
        const paths = yield* ServerConfig.deriveServerPaths("/tmp/t3", devUrl, {
          baseDirIsExplicit,
        });
        assert.equal(NodePath.basename(paths.dbPath), "statev2.sqlite");
        assert.equal(paths.settingsPath, NodePath.join(paths.stateDir, "settings.json"));
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("starts fresh without V1 and never imports over existing V2 state", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-fresh-"));
  const destinationPath = NodePath.join(directory, "userdata", "statev2.sqlite");
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const database = SqlitePersistence.layerConfig.pipe(
      Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE v2_work (text TEXT)`;
      yield* sql`INSERT INTO v2_work VALUES ('fresh V2 work')`;
    }).pipe(Effect.provide(database));
    const sourcePath = NodePath.join(NodePath.dirname(destinationPath), "state.sqlite");
    assert.isFalse(NodeFS.existsSync(sourcePath));
    NodeFS.writeFileSync(sourcePath, "This source must never be opened once V2 exists");
    yield* initializeV2Database(destinationPath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "fresh V2 work");
    }).pipe(Effect.provide(database));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

for (const scenario of [
  "later migration",
  "wrong migration name",
  "missing index",
  "wrong index",
  "wrong viewed schema",
  "wrong earlier history",
] as const) {
  it.effect(`refuses fork snapshots with ${scenario} before publishing V2`, () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-fork-refusal-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedForkMigrations(54);
        switch (scenario) {
          case "later migration":
            yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'UnknownForkMigration')`;
            break;
          case "wrong migration name":
            yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownForkMigration' WHERE migration_id = 54`;
            break;
          case "missing index":
            yield* sql`DROP INDEX idx_projection_turns_assistant_message_id`;
            break;
          case "wrong index":
            yield* sql`DROP INDEX idx_projection_turns_assistant_message_id`;
            yield* sql`CREATE INDEX idx_projection_turns_assistant_message_id ON projection_turns(thread_id)`;
            break;
          case "wrong viewed schema":
            yield* sql`ALTER TABLE pull_request_files_viewed ADD COLUMN unknown TEXT`;
            break;
          case "wrong earlier history":
            yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownForkMigration' WHERE migration_id = 52`;
            break;
        }
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));
      const original = NodeFS.readFileSync(sourcePath);
      const result = yield* Effect.result(initializeV2Database(destinationPath));
      assert.equal(result._tag, "Failure");
      assert.isFalse(NodeFS.existsSync(destinationPath));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
      assert.deepEqual(NodeFS.readdirSync(directory), ["state.sqlite"]);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  });
}
