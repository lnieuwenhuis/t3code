import { describe, expect, it } from "vite-plus/test";
import { parseDelegatedRunOutput } from "./DelegatedRunOutput.ts";

const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

describe("parseDelegatedRunOutput", () => {
  it.each([
    { error: { message: "Authentication failed" } },
    { error: { name: "APIError", data: { message: "Authentication failed" } } },
    { message: "Authentication failed" },
    { data: { message: "Authentication failed" } },
  ])("preserves OpenCode error diagnostics: %j", (error) => {
    expect(parseDelegatedRunOutput("opencode", lines({ type: "error", ...error }))).toMatchObject({
      failed: true,
      summary: "Authentication failed",
      usage: undefined,
    });
  });

  it.each(["opencode", "codex", "claude", "cursor", "grok"] as const)(
    "retains %s early plain diagnostics without inventing protocol status or usage",
    (provider) => {
      expect(parseDelegatedRunOutput(provider, "Error: authentication required\n")).toEqual({
        children: [],
        summary: "Error: authentication required",
        usage: undefined,
        failed: false,
      });
      expect(parseDelegatedRunOutput(provider, '{"type":"result","result":')).toEqual({
        children: [],
        summary: undefined,
        usage: undefined,
        failed: false,
      });
    },
  );

  it("does not replace structured OpenCode error text with preceding diagnostic noise", () => {
    expect(
      parseDelegatedRunOutput(
        "opencode",
        "starting CLI\n" + lines({ type: "error", error: { data: { message: "Denied" } } }),
      ),
    ).toMatchObject({ failed: true, summary: "Denied" });
  });

  it("deduplicates OpenCode steps and task snapshots by native identity", () => {
    const step = { type: "step_finish", part: { id: "step", tokens: { input: 10, output: 2 } } };
    const task = {
      type: "tool_use",
      part: {
        id: "part",
        callID: "call",
        tool: "task",
        state: {
          status: "completed",
          input: { description: "Review", subagent_type: "reviewer" },
          metadata: { sessionId: "child" },
          output: "done",
        },
      },
    };
    const parsed = parseDelegatedRunOutput("opencode", lines(step, step, task, task));
    expect(parsed.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      toolUses: 1,
    });
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children[0]).toMatchObject({ id: "child", title: "Review", summary: "done" });
  });

  it("reads Codex JSONL and lets successful turn completion supersede a retry diagnostic", () => {
    expect(
      parseDelegatedRunOutput(
        "codex",
        lines(
          { type: "error", message: "Reconnecting" },
          { type: "item.completed", item: { id: "msg", type: "agent_message", text: "Done" } },
          {
            type: "turn.completed",
            usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 3 },
          },
        ),
      ),
    ).toMatchObject({
      failed: false,
      summary: "Done",
      usage: { totalTokens: 23, inputTokens: 20, cachedInputTokens: 10, outputTokens: 3 },
    });
    expect(
      parseDelegatedRunOutput(
        "codex",
        lines({ type: "turn.failed", error: { message: "Unauthorized" } }),
      ),
    ).toMatchObject({ failed: true, summary: "Unauthorized" });
  });

  it.each(["claude", "cursor"] as const)("reads %s pretty JSON results and errors", (provider) => {
    expect(
      parseDelegatedRunOutput(
        provider,
        JSON.stringify(
          { type: "result", subtype: "success", result: "Done", is_error: false },
          null,
          2,
        ),
      ),
    ).toMatchObject({ summary: "Done", failed: false });
    expect(
      parseDelegatedRunOutput(
        provider,
        lines({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: ["Too many turns"],
        }),
      ),
    ).toMatchObject({ summary: "Too many turns", failed: true });
  });

  it("keeps Claude child text out of the parent summary and correlates native tasks", () => {
    const parsed = parseDelegatedRunOutput(
      "claude",
      lines(
        { type: "system", subtype: "init", model: "claude-model" },
        { type: "system", subtype: "task_started", task_id: "child", description: "Review" },
        {
          type: "assistant",
          parent_tool_use_id: "tool",
          message: { content: [{ type: "text", text: "child text" }] },
        },
        {
          type: "system",
          subtype: "task_notification",
          task_id: "child",
          status: "completed",
          summary: "review done",
        },
        {
          type: "result",
          subtype: "success",
          result: "parent done",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            output_tokens: 3,
          },
          duration_ms: 123,
        },
      ),
    );
    expect(parsed).toMatchObject({
      model: "claude-model",
      summary: "parent done",
      usage: { totalTokens: 38, cachedInputTokens: 20, durationMs: 123 },
    });
    expect(parsed.children).toEqual([
      expect.objectContaining({
        id: "child",
        title: "Review",
        summary: "review done",
        failed: false,
      }),
    ]);
  });

  it("reads Grok's documented single-object result", () => {
    expect(
      parseDelegatedRunOutput(
        "grok",
        JSON.stringify({ text: "Done", stopReason: "end_turn", sessionId: "s", requestId: "r" }),
      ),
    ).toMatchObject({ summary: "Done", failed: false });
  });

  it("reads Grok streaming text and terminal aggregate usage without double counting response usage", () => {
    expect(
      parseDelegatedRunOutput(
        "grok",
        lines(
          { type: "text", data: "Hello " },
          { type: "text", data: "world" },
          { type: "usage", messageId: "m", usage: { input_tokens: 10, output_tokens: 3 } },
          {
            type: "end",
            stopReason: "end_turn",
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 20,
              output_tokens: 3,
              total_tokens: 33,
            },
          },
        ),
      ),
    ).toMatchObject({ summary: "Hello world", failed: false, usage: { totalTokens: 33 } });
    expect(
      parseDelegatedRunOutput("grok", lines({ type: "error", message: "Cannot start" })),
    ).toMatchObject({ failed: true, summary: "Cannot start" });
  });

  it("does not invent completed children from Claude task starts alone", () => {
    expect(
      parseDelegatedRunOutput(
        "claude",
        lines({ type: "system", subtype: "task_started", task_id: "running" }),
      ).children,
    ).toEqual([]);
  });

  it("correlates Claude Agent tools with native task notifications without duplicate children", () => {
    const parsed = parseDelegatedRunOutput(
      "claude",
      lines(
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Agent",
                id: "tool",
                input: { description: "Inspect", subagent_type: "reviewer", model: "sonnet" },
              },
            ],
          },
        },
        { type: "system", subtype: "task_started", task_id: "task", tool_use_id: "tool" },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tool", content: "Found issue", is_error: false },
            ],
          },
        },
        {
          type: "system",
          subtype: "task_notification",
          task_id: "task",
          status: "completed",
          summary: "Found issue",
        },
      ),
    );
    expect(parsed.children).toEqual([
      {
        id: "task",
        title: "Inspect",
        role: "reviewer",
        model: "sonnet",
        summary: "Found issue",
        failed: false,
      },
    ]);
  });

  it("rejects invalid token values and preserves missing usage", () => {
    expect(
      parseDelegatedRunOutput(
        "codex",
        lines({ type: "turn.completed", usage: { input_tokens: -1, output_tokens: "10" } }),
      ).usage,
    ).toBeUndefined();
    expect(
      parseDelegatedRunOutput("claude", lines({ type: "result", usage: {} })).usage,
    ).toBeUndefined();
  });

  it("ignores malformed and unknown records without inventing usage", () => {
    expect(
      parseDelegatedRunOutput("codex", 'noise\n{broken\nnull\n[]\n{"type":"unknown"}'),
    ).toEqual({ children: [], summary: undefined, usage: undefined, failed: false });
  });
});
