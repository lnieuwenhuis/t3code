import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("allows unattended OpenCode approval only for an explicit Full Access mode", () => {
    const fullAccess = buildRuntimeInstructions({ harness: "Codex", runtimeMode: "full-access" });
    expect(fullAccess).toContain("opencode run --auto --format json");
    expect(fullAccess).toContain("explicit denies");
    for (const runtimeMode of [
      undefined,
      "approval-required",
      "auto-accept-edits",
      "auto",
    ] as const) {
      const instructions = buildRuntimeInstructions({ harness: "Codex", runtimeMode });
      expect(instructions).not.toContain("opencode run --auto");
      expect(instructions).toContain("Do not add auto-approval flags");
    }
  });

  it("preserves the OpenCode session directory and diagnoses permission waits before recovery", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("original session directory");
    expect(instructions).toContain("opencode export <session-id>");
    expect(instructions).toContain("permission.asked");
    expect(instructions).toContain("before --file");
  });

  it("adds local server lifecycle guidance only on Windows", () => {
    const windows = buildRuntimeInstructions({ harness: "Codex", platform: "win32" });
    expect(windows).toContain("127.0.0.1");
    expect(windows).toContain("finally");
    expect(windows).toContain("Do not disable UAC or the firewall");
    expect(buildRuntimeInstructions({ harness: "Codex", platform: "linux" })).not.toContain(
      "<windows_local_verification>",
    );
  });

  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});
