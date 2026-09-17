import {
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  OrchestrationThreadNotFoundError,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
  isOrchestrationThreadNotFoundError,
} from "./orchestration.ts";

describe("isOrchestrationThreadNotFoundError", () => {
  it("matches the typed not-found error", () => {
    expect(
      isOrchestrationThreadNotFoundError(
        new OrchestrationThreadNotFoundError({ threadId: ThreadId.make("thread-1") }),
      ),
    ).toBe(true);
  });

  it("rejects a generic snapshot error with a matching message", () => {
    expect(
      isOrchestrationThreadNotFoundError(
        new OrchestrationGetSnapshotError({
          message: "Thread thread-1 was not found",
          cause: "thread-1",
        }),
      ),
    ).toBe(false);
  });

  it("rejects plain errors with a matching message", () => {
    expect(isOrchestrationThreadNotFoundError(new Error("Thread thread-1 was not found"))).toBe(
      false,
    );
  });

  it("rejects other snapshot errors", () => {
    expect(
      isOrchestrationThreadNotFoundError(
        new OrchestrationGetSnapshotError({
          message: "Failed to load thread thread-1",
          cause: "thread-1",
        }),
      ),
    ).toBe(false);
  });

  it("rejects unrelated errors", () => {
    expect(isOrchestrationThreadNotFoundError(new Error("boom"))).toBe(false);
    expect(isOrchestrationThreadNotFoundError(null)).toBe(false);
  });
});

describe("wasBootstrapThreadDeleted", () => {
  it("accepts only a confirmed deleted bootstrap thread", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
  });

  it("rejects a missing disposition", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
  });

  it("rejects unrelated errors", () => {
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});

describe("wasBootstrapThreadNotCreated", () => {
  it("accepts only a confirmed never-created bootstrap thread", () => {
    const notCreated = new OrchestrationDispatchCommandError({
      message: "A separate worktree requires a base commit.",
      bootstrapThreadDisposition: "not-created",
    });
    expect(wasBootstrapThreadNotCreated(notCreated)).toBe(true);
    expect(wasBootstrapThreadDeleted(notCreated)).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
        }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadNotCreated(new Error("connection lost"))).toBe(false);
  });
});
