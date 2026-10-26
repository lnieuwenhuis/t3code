import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

const { parseAuth } = AzureDevOpsSourceControlProvider.discovery;

it("reads the signed-in Azure account and says when az is signed out", () => {
  assert.deepStrictEqual(parseAuth(processOutput("azure-user@example.com\n")), {
    status: "authenticated",
    account: Option.some("azure-user@example.com"),
    host: Option.some("dev.azure.com"),
    detail: Option.none(),
  });
  assert.strictEqual(
    parseAuth(
      processOutput("", {
        stderr: "Please run 'az login' to setup account.\n",
        exitCode: ChildProcessSpawner.ExitCode(1),
      }),
    ).status,
    "unauthenticated",
  );
  assert.strictEqual(parseAuth(processOutput("\n")).status, "unknown");
});

function makeProvider(azure: Partial<AzureDevOpsCli.AzureDevOpsCli["Service"]>) {
  return AzureDevOpsSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)(azure)),
  );
}

it.effect("preserves Azure DevOps fork provenance in provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 43,
          title: "Add Azure fork support",
          url: "https://dev.azure.com/acme/target-project/_git/repo/pullrequest/43",
          baseRefName: "main",
          headRefName: "feature/from-fork",
          state: "open",
          updatedAt: Option.none(),
          isCrossRepository: true,
          headRepositoryNameWithOwner: "fork-project/repo-fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "43",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: SourceControlProviderKind.make("azure-devops"),
      number: 43,
      title: "Add Azure fork support",
      url: "https://dev.azure.com/acme/target-project/_git/repo/pullrequest/43",
      baseRefName: "main",
      headRefName: "feature/from-fork",
      state: "open",
      closedAt: null,
      mergedAt: null,
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork-project/repo-fork",
    });
  }),
);
