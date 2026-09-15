import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { extractClaudeRespectGitignore, resolveClaudeRespectGitignore } from "./claudeSettings.ts";

describe("extractClaudeRespectGitignore", () => {
  it("reads top-level settings.json values", () => {
    expect(extractClaudeRespectGitignore({ respectGitignore: false })).toBe(false);
    expect(extractClaudeRespectGitignore({ respectGitignore: true })).toBe(true);
  });

  it("falls back to a nested legacy settings object", () => {
    expect(extractClaudeRespectGitignore({ settings: { respectGitignore: false } })).toBe(false);
  });

  it("returns undefined for unrelated shapes", () => {
    expect(extractClaudeRespectGitignore({})).toBeUndefined();
    expect(extractClaudeRespectGitignore(null)).toBeUndefined();
    expect(extractClaudeRespectGitignore("false")).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("resolveClaudeRespectGitignore", (it) => {
  it.effect("defaults to respecting gitignore when no Claude setting is present", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const homeDirectory = yield* fs.makeTempDirectoryScoped();
      expect(yield* resolveClaudeRespectGitignore(cwd, { homeDirectory })).toBe(true);
    }),
  );
  it.effect("applies project-local settings over user settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const homeDirectory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(homeDirectory, ".claude"));
      yield* fs.makeDirectory(path.join(cwd, ".claude"));
      yield* fs.writeFileString(
        path.join(homeDirectory, ".claude/settings.json"),
        '{"respectGitignore":true}',
      );
      yield* fs.writeFileString(
        path.join(cwd, ".claude/settings.local.json"),
        '{"respectGitignore":false}',
      );
      expect(yield* resolveClaudeRespectGitignore(cwd, { homeDirectory })).toBe(false);
    }),
  );
});
