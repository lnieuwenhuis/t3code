import * as NodeOS from "node:os";
import { Effect, FileSystem, Path, Schema } from "effect";

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

function readClaudeRespectGitignoreFromFile(settingsPath: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.catch(() => Effect.succeed(null)));

    if (contents === null) {
      return undefined;
    }

    return yield* decodeSettings(contents).pipe(
      Effect.map(extractClaudeRespectGitignore),
      Effect.orElseSucceed(() => undefined),
    );
  });
}

export function resolveClaudeRespectGitignore(cwd: string, options?: { homeDirectory?: string }) {
  return Effect.gen(function* () {
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
}
