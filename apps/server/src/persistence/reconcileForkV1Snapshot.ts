import * as NodeSqlite from "node:sqlite";

import { migrationManifest } from "./Migrations.ts";

const assistantIndexSql = `CREATE INDEX idx_projection_turns_assistant_message_id
  ON projection_turns(assistant_message_id) WHERE assistant_message_id IS NOT NULL`;
const viewedTableSql = `CREATE TABLE pull_request_files_viewed (
  provider TEXT NOT NULL,
  host TEXT NOT NULL,
  repository TEXT NOT NULL,
  number INTEGER NOT NULL,
  viewer TEXT NOT NULL,
  path TEXT NOT NULL,
  revision TEXT,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY (provider, host, repository, number, viewer, path)
) WITHOUT ROWID`;

const normalizeSql = (sql: string) => sql.replace(/\s+/g, "").toLowerCase();

/** Only call on the private backup, before publishing it as statev2.sqlite. */
export function reconcileForkV1Snapshot(snapshotPath: string): void {
  const snapshot = new NodeSqlite.DatabaseSync(snapshotPath, { readOnly: true });
  let hasViewed: boolean | undefined;
  try {
    hasViewed = inspectForkV1Snapshot(snapshot);
  } finally {
    snapshot.close();
  }
  if (hasViewed === undefined) return;

  const database = new NodeSqlite.DatabaseSync(snapshotPath);
  try {
    // The published snapshot must contain these writes in its main file, not a
    // WAL left behind in the temporary directory. The source is never opened here.
    database.exec("PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE");
    try {
      // Fork 53 only added an index, which can remain. Its 54 is upstream 53.
      // Free upstream 54 so the authoritative runner adds auto_settle_disabled_at.
      database.exec("DELETE FROM effect_sql_migrations WHERE migration_id = 53");
      if (hasViewed) {
        database.exec("UPDATE effect_sql_migrations SET migration_id = 53 WHERE migration_id = 54");
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function inspectForkV1Snapshot(database: NodeSqlite.DatabaseSync): boolean | undefined {
  const trackingTable = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
    )
    .get();
  if (!trackingTable) return;
  const history = database
    .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
    .all();
  const isFork = history.some(
    (row) =>
      row.name === "ProjectionTurnsAssistantMessageIndex" ||
      (row.migration_id === 54 && row.name === "PullRequestFilesViewed"),
  );
  if (!isFork) return;

  const hasViewed = history.some(
    (row) => row.migration_id === 54 && row.name === "PullRequestFilesViewed",
  );
  const expected = [
    ...migrationManifest.filter(([id]) => id <= 52),
    [53, "ProjectionTurnsAssistantMessageIndex"] as const,
    ...(hasViewed ? [[54, "PullRequestFilesViewed"] as const] : []),
  ];
  if (
    history.length !== expected.length ||
    expected.some(
      ([id, name], index) => history[index]?.migration_id !== id || history[index]?.name !== name,
    )
  ) {
    throw new Error("Cannot import fork V1 database with unexpected migration history.");
  }

  const schemaSql = (type: string, name: string) =>
    database.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name)
      ?.sql;
  const indexSql = schemaSql("index", "idx_projection_turns_assistant_message_id");
  const viewedSql = schemaSql("table", "pull_request_files_viewed");
  if (
    typeof indexSql !== "string" ||
    normalizeSql(indexSql) !== normalizeSql(assistantIndexSql) ||
    (hasViewed
      ? typeof viewedSql !== "string" || normalizeSql(viewedSql) !== normalizeSql(viewedTableSql)
      : viewedSql !== undefined)
  ) {
    throw new Error("Cannot import fork V1 database with unexpected migration schema.");
  }

  return hasViewed;
}
