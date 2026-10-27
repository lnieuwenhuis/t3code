import { describe, expect, it } from "vite-plus/test";

import {
  fillNewTaskWorkspaceBranch,
  filterNewTaskBranches,
  resolveNewTaskBranchAfterModeChange,
  resolveNewTaskBranchLabel,
  resolveNewTaskBranchWorktreePath,
  resolveNewTaskLocalWorkspaceSelection,
  resolveNewTaskWorkspaceSelection,
} from "./new-task-context-presentation";

describe("resolveNewTaskWorkspaceSelection", () => {
  const fallback = { mode: "worktree", branch: null, worktreePath: null } as const;

  it("falls back to the current checkout when a non-git project defaults to worktree", () => {
    expect(
      resolveNewTaskWorkspaceSelection({ selection: undefined, fallback, isGitRepo: false }),
    ).toEqual({ mode: "local", branch: null, worktreePath: null });
  });

  it.each(["local", "worktree"] as const)(
    "clears stale %s selections for non-git projects",
    (mode) => {
      expect(
        resolveNewTaskWorkspaceSelection({
          selection: {
            mode,
            branch: "main",
            worktreePath: "/old-worktree",
            startFromOrigin: true,
            pullRequestReference: "https://github.com/acme/repo/pull/123",
          },
          fallback,
          isGitRepo: false,
        }),
      ).toEqual({ mode: "local", branch: null, worktreePath: null });
    },
  );

  // regression: #21404 use current checkout for non-git projects
  it("preserves the selection and defaults for git projects", () => {
    const selection = { mode: "local", branch: "feature", worktreePath: "/worktree" } as const;
    expect(resolveNewTaskWorkspaceSelection({ selection, fallback, isGitRepo: true })).toBe(
      selection,
    );
    expect(
      resolveNewTaskWorkspaceSelection({ selection: undefined, fallback, isGitRepo: true }),
    ).toBe(fallback);
  });
});

describe("resolveNewTaskBranchLabel", () => {
  it.each([
    ["https://github.com/acme/repo/pull/123", "From PR #123"],
    ["https://gitlab.com/acme/repo/-/merge_requests/123", "From MR #123"],
  ])("names the change request a worktree starts from (%s)", (pullRequestReference, label) => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: null,
        startFromOrigin: false,
        workspaceMode: "worktree",
        pullRequestReference,
      }),
    ).toBe(label);
  });
});

describe("resolveNewTaskLocalWorkspaceSelection", () => {
  it("waits for refs instead of carrying a worktree base into Current checkout", () => {
    expect(
      resolveNewTaskLocalWorkspaceSelection({
        branches: [],
        projectCwd: "/repo",
      }),
    ).toEqual({
      branch: null,
      worktreePath: null,
      awaitsCurrentBranch: true,
    });
  });

  it("carries the worktree path when the current branch lives in another worktree", () => {
    expect(
      resolveNewTaskLocalWorkspaceSelection({
        branches: [
          { name: "feature/split", current: true, worktreePath: "/repo/.t3/worktrees/split" },
          { name: "main", current: false, worktreePath: "/repo" },
        ],
        projectCwd: "/repo",
      }),
    ).toEqual({
      branch: "feature/split",
      worktreePath: "/repo/.t3/worktrees/split",
      awaitsCurrentBranch: false,
    });
  });
});

describe("resolveNewTaskBranchWorktreePath", () => {
  it("does not reuse an existing worktree while creating a new one", () => {
    expect(
      resolveNewTaskBranchWorktreePath({
        workspaceMode: "worktree",
        projectCwd: "/repo",
        branchWorktreePath: "/repo/.t3/worktrees/feature",
      }),
    ).toBeNull();
  });
});

describe("resolveNewTaskBranchLabel", () => {
  it("identifies a deferred PR checkout independently of the origin default", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: "fork/feature",
        startFromOrigin: true,
        workspaceMode: "worktree",
        pullRequestReference: "https://github.com/acme/repo/pull/123",
      }),
    ).toBe("From PR #123");
  });
  it("shows the checked-out branch without a base-ref prefix", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: "feature/mobile",
        startFromOrigin: true,
        workspaceMode: "local",
      }),
    ).toBe("feature/mobile");
  });

  it("labels a local worktree base with From", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: "main",
        startFromOrigin: false,
        workspaceMode: "worktree",
      }),
    ).toBe("From main");
  });

  it("labels a worktree base whose remote is resolved by the server", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: "main",
        startFromOrigin: true,
        workspaceMode: "worktree",
      }),
    ).toBe("From main (remote)");
  });

  it("prompts when no branch is available", () => {
    expect(
      resolveNewTaskBranchLabel({
        branchName: null,
        startFromOrigin: true,
        workspaceMode: "worktree",
      }),
    ).toBe("Choose branch");
  });
});

describe("filterNewTaskBranches", () => {
  const branches = [
    { name: "main", isRemote: false },
    { name: "Feature/Login-Page", isRemote: false },
    { name: "origin/fix/remote-only", isRemote: true },
  ];
  const search = (query: string) =>
    filterNewTaskBranches(branches, query).map((branch) => branch.name);

  it("ignores case in both the query and the branch name", () => {
    expect(search("feature/login")).toEqual(["Feature/Login-Page"]);
    expect(search("MAIN")).toEqual(["main"]);
  });

  it("keeps remote-only branches searchable", () => {
    expect(search("remote-only")).toEqual(["origin/fix/remote-only"]);
  });

  it("matches a typed space against the dash a branch name uses", () => {
    expect(search("  login page ")).toEqual(["Feature/Login-Page"]);
  });
});

describe("resolveNewTaskBranchAfterModeChange", () => {
  it("clears an inherited checkout branch so a new worktree can choose the default", () => {
    expect(
      resolveNewTaskBranchAfterModeChange("local", "worktree", "feature/local-only"),
    ).toBeNull();
  });

  it("preserves an explicitly selected worktree base when the mode is unchanged", () => {
    expect(resolveNewTaskBranchAfterModeChange("worktree", "worktree", "release")).toBe("release");
  });

  it("leaves other transitions and an absent selection alone", () => {
    expect(resolveNewTaskBranchAfterModeChange("worktree", "local", "main")).toBe("main");
    expect(resolveNewTaskBranchAfterModeChange("local", "local", "feature")).toBe("feature");
    expect(resolveNewTaskBranchAfterModeChange("local", "worktree", null)).toBeNull();
  });
});

describe("fillNewTaskWorkspaceBranch", () => {
  const branches = [
    { name: "origin/main", current: false, isDefault: true, isRemote: true },
    { name: "feature", current: true, isDefault: false, worktreePath: "/repo-feature" },
  ];
  const base = {
    branches,
    projectCwd: "/repo",
    worktreeDefaultSettled: true,
  };

  it("bases a new worktree on the default branch, even when only the remote has it", () => {
    expect(
      fillNewTaskWorkspaceBranch({
        ...base,
        selection: { mode: "worktree", branch: null, worktreePath: null },
      }),
    ).toEqual({ mode: "worktree", branch: "origin/main", worktreePath: null });
  });

  it("waits for the workspace default to settle before picking a base", () => {
    const selection = { mode: "worktree", branch: null, worktreePath: null } as const;
    expect(fillNewTaskWorkspaceBranch({ ...base, selection, worktreeDefaultSettled: false })).toBe(
      selection,
    );
  });

  it("follows the current checkout only for a local selection the user just chose", () => {
    const selection = { mode: "local", branch: null, worktreePath: null } as const;
    expect(fillNewTaskWorkspaceBranch({ ...base, selection })).toBe(selection);
    expect(
      fillNewTaskWorkspaceBranch({
        ...base,
        selection: { ...selection, followsCurrentCheckout: true },
      }),
    ).toEqual({
      mode: "local",
      branch: "feature",
      worktreePath: "/repo-feature",
      followsCurrentCheckout: true,
    });
  });

  it("fills the current branch once refs arrive after local mode was chosen", () => {
    const selection = {
      mode: "local",
      branch: null,
      worktreePath: null,
      followsCurrentCheckout: true,
    } as const;
    expect(fillNewTaskWorkspaceBranch({ ...base, branches: [], selection })).toBe(selection);
    expect(fillNewTaskWorkspaceBranch({ ...base, selection })).toMatchObject({
      branch: "feature",
      worktreePath: "/repo-feature",
    });
  });

  it("keeps an explicit branch", () => {
    const selection = { mode: "worktree", branch: "release", worktreePath: null } as const;
    expect(fillNewTaskWorkspaceBranch({ ...base, selection })).toBe(selection);
  });
});
