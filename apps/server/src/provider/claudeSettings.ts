import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

function getBooleanProperty(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function extractClaudeRespectGitignore(value: unknown): boolean | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const topLevel = getBooleanProperty(record, "respectGitignore");
  if (topLevel !== undefined) {
    return topLevel;
  }

  const nestedSettings = record.settings;
  if (nestedSettings === null || typeof nestedSettings !== "object") {
    return undefined;
  }

  return getBooleanProperty(nestedSettings as Record<string, unknown>, "respectGitignore");
}

const readClaudeRespectGitignoreFromFile = Effect.fn("readClaudeRespectGitignoreFromFile")(
  function* (settingsPath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => null));

    if (contents === null) {
      return undefined;
    }

    return yield* decodeSettings(contents).pipe(
      Effect.map(extractClaudeRespectGitignore),
      Effect.orElseSucceed(() => undefined),
    );
  },
);

export const resolveClaudeRespectGitignore = Effect.fn("resolveClaudeRespectGitignore")(function* (
  cwd: string,
  options?: { homeDirectory?: string },
) {
  const path = yield* Path.Path;
  const homeDirectory =
    options?.homeDirectory ?? process.env.HOME ?? process.env.USERPROFILE ?? NodeOS.homedir();
  const candidatePaths = [
    path.join(homeDirectory, ".claude.json"),
    path.join(homeDirectory, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
  ];

  let respectGitignore = true;
  for (const candidatePath of candidatePaths) {
    const nextValue = yield* readClaudeRespectGitignoreFromFile(candidatePath);
    if (nextValue !== undefined) {
      respectGitignore = nextValue;
    }
  }

  return respectGitignore;
});
