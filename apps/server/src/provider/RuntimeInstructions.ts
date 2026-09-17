import type { RuntimeMode } from "@t3tools/contracts";

const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

function delegatedOpenCodeInstructions(runtimeMode: RuntimeMode | undefined): string {
  const permissions =
    runtimeMode === "full-access"
      ? "This T3 thread is in Full Access mode. For authorized unattended work, launch OpenCode with `opencode run --auto --format json` so the child can approve requests without a terminal. First verify `opencode run --help` supports `--auto`; it retains explicit denies. This does not authorize unrelated work or override task-specific restrictions."
      : "This T3 thread does not grant unattended Full Access to delegated workers. Do not add auto-approval flags or broaden permission settings. Use task-scoped permissions already authorized by the user; report any remaining permission blocker.";
  return `<delegated_opencode>
When delegating through the OpenCode CLI, the child does not automatically inherit T3's permission mode. ${permissions}
Keep the exact requested provider/model and reasoning variant. Use one foreground invocation per shell tool call. Put the task prompt before --file, whose array argument can otherwise consume the prompt as a filename.
Record the initial --dir and session ID. When resuming, use the original session directory with --session; if it is unknown, inspect only the directory metadata from opencode export <session-id> without printing the transcript. Do not change --dir to a parent directory to gain file access: a resumed session can keep its original directory while its event subscription listens elsewhere, leaving permission requests unanswered. Use authorized scoped permissions or report the blocker instead.
Before killing a quiet worker or retrying a tool, distinguish a pending permission.asked event from a running command, model request, or completed task. A permission wait is not evidence of a hung file reader or Git command. Preserve edits and avoid duplicate workers; do not bypass an explicit deny.
</delegated_opencode>`;
}

const WINDOWS_LOCAL_VERIFICATION_INSTRUCTIONS = `<windows_local_verification>
For Windows-only local verification, prefer services bound to 127.0.0.1 (or ::1) through the application's supported settings. Do not assume a HOST environment variable is honored; inspect the actual bind configuration and listener. Newly built server executables in different worktrees can trigger separate Windows Firewall prompts. A firewall prompt is distinct from UAC elevation and neither is handled by T3's Full Access mode.
Use a bounded command that starts a hidden test server, records its exact PID, checks health with a timeout, runs the tests, and stops that owned server in finally. Background descendants can keep a shell tool's output handles open. Never kill by process-name pattern. Do not disable UAC or the firewall, weaken authentication to get loopback binding, or launch elevated to avoid a prompt. If the application has no suitable local-only bind setting, report that specific limitation rather than silently changing OS settings.
</windows_local_verification>`;

/** Shared runtime context; omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${model}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return [
    `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>`,
    PULL_REQUEST_LINKING_INSTRUCTIONS,
    delegatedOpenCodeInstructions(runtime.runtimeMode),
    ...(runtime.platform === "win32" ? [WINDOWS_LOCAL_VERIFICATION_INSTRUCTIONS] : []),
  ].join("\n\n");
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
