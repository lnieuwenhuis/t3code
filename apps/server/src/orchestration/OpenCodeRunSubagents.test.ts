import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveOpenCodeRunEvents,
  openCodeRunItemKey,
  parseOpenCodeRunCommand,
  parseOpenCodeRunOutput,
} from "./OpenCodeRunSubagents.ts";

const base = {
  provider: ProviderDriverKind.make("claude"),
  createdAt: "2026-09-11T10:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
  itemId: RuntimeItemId.make("tool-1"),
};

const jsonLine = (value: unknown) => JSON.stringify(value);

const runJsonOutput = [
  jsonLine({
    type: "step_start",
    timestamp: 1_000,
    sessionID: "ses_parent",
    part: { type: "step-start" },
  }),
  jsonLine({
    type: "tool_use",
    timestamp: 1_500,
    sessionID: "ses_parent",
    part: {
      id: "prt_1",
      callID: "call_1",
      tool: "task",
      state: {
        status: "completed",
        title: "Multiply numbers",
        input: {
          description: "Multiply numbers",
          prompt: "What is 17 * 23?",
          subagent_type: "flash",
        },
        output:
          '<task id="ses_child_1" state="completed">\n<task_result>\n391\n</task_result>\n</task>',
        metadata: {
          parentSessionId: "ses_parent",
          sessionId: "ses_child_1",
          model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
        },
        time: { start: 1_100, end: 1_400 },
      },
    },
  }),
  jsonLine({
    type: "tool_use",
    timestamp: 1_600,
    sessionID: "ses_parent",
    part: {
      id: "prt_2",
      callID: "call_2",
      tool: "task",
      state: {
        status: "error",
        input: { description: "Sort words", subagent_type: "flash" },
        error: "Task failed",
        metadata: { sessionId: "ses_child_2", model: { modelID: "deepseek-v4.1-flash" } },
      },
    },
  }),
  jsonLine({
    type: "tool_use",
    timestamp: 1_700,
    sessionID: "ses_parent",
    part: { id: "prt_3", callID: "call_3", tool: "read", state: { status: "completed" } },
  }),
  jsonLine({
    type: "step_finish",
    timestamp: 1_800,
    sessionID: "ses_parent",
    part: {
      type: "step-finish",
      tokens: { total: 120, input: 100, output: 15, reasoning: 5, cache: { write: 0, read: 30 } },
    },
  }),
  jsonLine({
    type: "text",
    timestamp: 1_900,
    sessionID: "ses_parent",
    part: { type: "text", text: "Both tasks finished: 391 and a failure." },
  }),
  jsonLine({
    type: "step_finish",
    timestamp: 2_000,
    sessionID: "ses_parent",
    part: {
      type: "step-finish",
      tokens: { total: 40, input: 30, output: 10, reasoning: 0, cache: { write: 0, read: 0 } },
    },
  }),
  "not json",
].join("\n");

describe("parseOpenCodeRunCommand", () => {
  it("reads the prompt, model, agent, and output format", () => {
    expect(
      parseOpenCodeRunCommand(
        `cd /tmp && OPENCODE_CONFIG=x opencode run --format json -m opencode-go/deepseek-v4.1-flash --agent orchestrator "Multiply   17 by 23" 2>&1 | head -50`,
      ),
    ).toEqual({
      prompt: "Multiply 17 by 23",
      model: "opencode-go/deepseek-v4.1-flash",
      agent: "orchestrator",
      jsonOutput: true,
    });
  });

  it("handles equals-style options, quoted prompts, and absolute binaries", () => {
    expect(
      parseOpenCodeRunCommand(
        "/Users/me/.opencode/bin/opencode run --model=zen/big 'say \"hi\"' there --auto",
      ),
    ).toEqual({ prompt: 'say "hi" there', model: "zen/big", agent: undefined, jsonOutput: false });
  });

  it("looks inside a shell wrapper", () => {
    expect(
      parseOpenCodeRunCommand(`/bin/zsh -lc "opencode run --format json 'Review the diff'"`),
    ).toEqual({ prompt: "Review the diff", model: undefined, agent: undefined, jsonOutput: true });
  });

  it("drops prompts built from command substitution", () => {
    expect(parseOpenCodeRunCommand('opencode run "$(cat prompt.md)"')?.prompt).toBeUndefined();
  });

  it("ignores other opencode subcommands and unrelated commands", () => {
    expect(parseOpenCodeRunCommand("opencode serve --port 4096")).toBeUndefined();
    expect(parseOpenCodeRunCommand("echo 'opencode run is nice'")).toBeUndefined();
    expect(parseOpenCodeRunCommand("bun run lint")).toBeUndefined();
  });

  it("only matches when opencode is the command being run", () => {
    expect(parseOpenCodeRunCommand("echo opencode run test")).toBeUndefined();
    expect(parseOpenCodeRunCommand("grep -rn opencode run .")).toBeUndefined();
    expect(parseOpenCodeRunCommand("timeout 60 opencode run 'Say hi'")?.prompt).toBe("Say hi");
    expect(parseOpenCodeRunCommand("env FOO=1 nohup opencode run 'Say hi'")?.prompt).toBe("Say hi");
    expect(parseOpenCodeRunCommand("ls;opencode run 'Say hi'|head 2>&1")?.prompt).toBe("Say hi");
    expect(parseOpenCodeRunCommand('cd /repo\nopencode run "Say hi"\necho done')?.prompt).toBe(
      "Say hi",
    );
    expect(parseOpenCodeRunCommand('opencode run \\\n  --format json \\\n  "Say hi"')).toEqual({
      prompt: "Say hi",
      model: undefined,
      agent: undefined,
      jsonOutput: true,
    });
  });
});

describe("parseOpenCodeRunOutput", () => {
  it("folds children, usage, and the final text out of the JSON event stream", () => {
    expect(parseOpenCodeRunOutput(runJsonOutput)).toEqual({
      children: [
        {
          id: "ses_child_1",
          title: "Multiply numbers",
          role: "flash",
          model: "opencode-go/deepseek-v4.1-flash",
          failed: false,
          summary: "391",
        },
        {
          id: "ses_child_2",
          title: "Sort words",
          role: "flash",
          model: "deepseek-v4.1-flash",
          failed: true,
          summary: "Task failed",
        },
      ],
      summary: "Both tasks finished: 391 and a failure.",
      usage: {
        totalTokens: 160,
        inputTokens: 130,
        cachedInputTokens: 30,
        outputTokens: 25,
        reasoningOutputTokens: 5,
        toolUses: 3,
        durationMs: 1_000,
      },
      failed: false,
    });
  });

  it("flags a run whose stream carried an error event", () => {
    const output = parseOpenCodeRunOutput(
      jsonLine({ type: "error", timestamp: 1, sessionID: "ses", error: { name: "Boom" } }),
    );
    expect(output.failed).toBe(true);
    expect(output.usage).toBeUndefined();
  });
});

describe("deriveOpenCodeRunEvents", () => {
  const claudeItem = (
    type: "item.started" | "item.updated" | "item.completed",
    input: Record<string, unknown>,
    extra: { status?: "completed" | "failed"; result?: unknown } = {},
  ) =>
    ({
      ...base,
      type,
      eventId: EventId.make(`evt-${type}`),
      payload: {
        itemType: "command_execution",
        status: extra.status ?? "inProgress",
        title: "Command run",
        data: {
          toolName: "Bash",
          input,
          ...(extra.result !== undefined ? { result: extra.result } : {}),
        },
      },
    }) satisfies ProviderRuntimeEvent;

  const command = 'opencode run --format json -m opencode-go/deepseek-v4.1-flash "Run both tasks"';

  it("keys only shell items", () => {
    expect(openCodeRunItemKey(claudeItem("item.started", {}))).toBe("thread-1:tool-1");
    expect(
      openCodeRunItemKey({
        ...base,
        type: "item.completed",
        eventId: EventId.make("evt-read"),
        payload: { itemType: "file_change" },
      }),
    ).toBeUndefined();
  });

  it("stays quiet until the streamed command is readable", () => {
    expect(deriveOpenCodeRunEvents(claudeItem("item.started", {}), { started: false })).toEqual([]);
    expect(
      deriveOpenCodeRunEvents(claudeItem("item.updated", { command: "bun run lint" }), {
        started: false,
      }),
    ).toEqual([]);
  });

  it("starts the delegated run once from the first readable command", () => {
    const events = deriveOpenCodeRunEvents(claudeItem("item.updated", { command }), {
      started: false,
    });
    expect(events).toEqual([
      {
        provider: base.provider,
        threadId: base.threadId,
        turnId: base.turnId,
        createdAt: base.createdAt,
        eventId: "evt-item.updated:opencode-run:1",
        type: "task.started",
        payload: {
          taskId: "opencode-run:tool-1",
          description: "Run both tasks",
          taskType: "subagent",
          title: "Run both tasks",
          role: "opencode",
          model: "opencode-go/deepseek-v4.1-flash",
          toolUseId: "tool-1",
        },
      },
    ]);
    expect(
      deriveOpenCodeRunEvents(claudeItem("item.updated", { command }), { started: true }),
    ).toEqual([]);
  });

  it("skips background shells whose output arrives elsewhere", () => {
    expect(
      deriveOpenCodeRunEvents(claudeItem("item.updated", { command, run_in_background: true }), {
        started: false,
      }),
    ).toEqual([]);
  });

  it("settles the run and its children from the captured JSON output", () => {
    const events = deriveOpenCodeRunEvents(
      claudeItem(
        "item.completed",
        { command },
        {
          status: "completed",
          result: { type: "tool_result", tool_use_id: "tool-1", content: runJsonOutput },
        },
      ),
      { started: true },
    );
    expect(events.map((event) => [event.type, event.eventId])).toEqual([
      ["task.started", "evt-item.completed:opencode-run:1"],
      ["task.completed", "evt-item.completed:opencode-run:2"],
      ["task.started", "evt-item.completed:opencode-run:3"],
      ["task.completed", "evt-item.completed:opencode-run:4"],
      ["task.completed", "evt-item.completed:opencode-run:5"],
    ]);
    expect(events[0]?.payload).toEqual({
      taskId: "opencode-run:tool-1:ses_child_1",
      description: "Multiply numbers",
      taskType: "subagent",
      title: "Multiply numbers",
      role: "flash",
      model: "opencode-go/deepseek-v4.1-flash",
      toolUseId: "tool-1",
    });
    expect(events[3]?.payload).toMatchObject({
      taskId: "opencode-run:tool-1:ses_child_2",
      status: "failed",
      summary: "Task failed",
    });
    expect(events[4]?.payload).toEqual({
      taskId: "opencode-run:tool-1",
      status: "completed",
      summary: "Both tasks finished: 391 and a failure.",
      typedUsage: {
        totalTokens: 160,
        inputTokens: 130,
        cachedInputTokens: 30,
        outputTokens: 25,
        reasoningOutputTokens: 5,
        toolUses: 3,
        durationMs: 1_000,
      },
      taskType: "subagent",
      title: "Run both tasks",
      role: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
      toolUseId: "tool-1",
    });
  });

  it("starts and settles in one go when the command was never seen before", () => {
    const events = deriveOpenCodeRunEvents(
      claudeItem(
        "item.completed",
        { command: "opencode run 'Say hi'" },
        { status: "failed", result: { content: [{ type: "text", text: "boom" }], is_error: true } },
      ),
      { started: false },
    );
    expect(events.map((event) => event.type)).toEqual(["task.started", "task.completed"]);
    expect(events[1]?.payload).toMatchObject({
      taskId: "opencode-run:tool-1",
      status: "failed",
      summary: "boom",
      title: "Say hi",
    });
  });

  it("reads Codex and ACP shaped command items", () => {
    const codex = deriveOpenCodeRunEvents(
      {
        ...base,
        provider: ProviderDriverKind.make("codex"),
        type: "item.completed",
        eventId: EventId.make("evt-codex"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          data: {
            item: {
              type: "commandExecution",
              command: "opencode run 'Codex says hi'",
              aggregatedOutput: "hi from opencode",
              exitCode: 0,
            },
          },
        },
      },
      { started: false },
    );
    expect(codex[1]?.payload).toMatchObject({
      status: "completed",
      summary: "hi from opencode",
      title: "Codex says hi",
    });

    const acp = deriveOpenCodeRunEvents(
      {
        ...base,
        provider: ProviderDriverKind.make("cursor"),
        type: "item.completed",
        eventId: EventId.make("evt-acp"),
        payload: {
          itemType: "command_execution",
          status: "completed",
          data: {
            toolCallId: "tool-call-1",
            kind: "execute",
            command: "opencode run 'Cursor says hi'",
            rawOutput: { stdout: "hi from cursor" },
          },
        },
      },
      { started: false },
    );
    expect(acp[1]?.payload).toMatchObject({ summary: "hi from cursor", title: "Cursor says hi" });
  });
});
