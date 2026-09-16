import { EventId, RuntimeTaskId, type ProviderRuntimeEvent } from "@t3tools/contracts";

import { parseDelegatedRunCommand, type DelegatedRunInvocation } from "./DelegatedRunCommand.ts";
import { parseDelegatedRunOutput } from "./DelegatedRunOutput.ts";

/** Narrows an unknown value to a plain object record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Narrows an unknown value to a string. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Each provider shapes `payload.data` differently: Claude stores the tool
 * input, Codex the native item, and the ACP adapters a flat record.
 */
function commandFromItemData(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  return (
    asString(data.command) ??
    asString(asRecord(data.input)?.command) ??
    asString(asRecord(data.item)?.command) ??
    asString(asRecord(asRecord(data.state)?.input)?.command)
  );
}

/** Claude's Bash tool returns at once for `run_in_background`, so its output is elsewhere. */
function isBackgroundShellItem(data: Record<string, unknown> | undefined): boolean {
  return (
    asRecord(data?.input)?.run_in_background === true ||
    asRecord(asRecord(data?.state)?.input)?.run_in_background === true
  );
}

/** Text of a tool result `content`, which is a string or an array of text blocks. */
function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        const record = asRecord(block);
        const nested = record?.type === "content" ? asRecord(record.content) : undefined;
        return (
          asString(record?.text) ?? (nested?.type === "text" ? asString(nested.text) : undefined)
        );
      })
      .filter((value): value is string => value !== undefined)
      .join("\n");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/** Captured command output from each provider's `data` shape, if the item carries any. */
function outputFromItemData(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  const result = data.result;
  if (typeof result === "string") {
    return result;
  }
  const resultRecord = asRecord(result);
  if (resultRecord) {
    const text =
      textFromContent(resultRecord.content) ??
      asString(resultRecord.stdout) ??
      asString(resultRecord.output);
    if (text !== undefined) return text;
  }
  const item = asRecord(data.item);
  const aggregatedOutput = asString(item?.aggregatedOutput);
  if (aggregatedOutput !== undefined) {
    return aggregatedOutput;
  }
  const rawOutput = data.rawOutput;
  if (typeof rawOutput === "string") {
    return rawOutput;
  }
  const rawOutputRecord = asRecord(rawOutput);
  return (
    asString(rawOutputRecord?.stdout) ??
    asString(rawOutputRecord?.output) ??
    textFromContent(data.content) ??
    asString(asRecord(data.state)?.error) ??
    asString(asRecord(data.state)?.output)
  );
}

type TaskStartedEvent = Extract<ProviderRuntimeEvent, { type: "task.started" }>;
type TaskCompletedEvent = Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
type CommandItemEvent = Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;

/** The event when it is a shell item lifecycle event with an item id. */
function asCommandItemEvent(event: ProviderRuntimeEvent): CommandItemEvent | undefined {
  if (
    (event.type !== "item.started" &&
      event.type !== "item.updated" &&
      event.type !== "item.completed") ||
    event.payload.itemType !== "command_execution" ||
    event.itemId === undefined
  ) {
    return undefined;
  }
  return event;
}

/** Ingestion state key for one shell item, so task.started goes out once. */
export function delegatedRunItemKey(event: ProviderRuntimeEvent): string | undefined {
  const item = asCommandItemEvent(event);
  return item ? `${item.threadId}:${item.itemId}` : undefined;
}

/** Identity fields shared by every task event of one delegated run. */
function taskLinkage(invocation: DelegatedRunInvocation, toolUseId: string) {
  return {
    taskType: "subagent",
    title: invocation.prompt ?? `${invocation.provider} run`,
    role: invocation.agent ?? invocation.provider,
    ...(invocation.model ? { model: invocation.model } : {}),
    toolUseId,
  } as const;
}

/**
 * Derives task events from a foreground provider CLI command. `started`
 * tells whether this item's run already has a task.started; the caller owns
 * that memory because a Claude Bash item streams its input across several
 * item.updated events before the command is readable.
 */
export function deriveDelegatedRunEvents(
  event: ProviderRuntimeEvent,
  options: {
    readonly started: boolean;
    readonly invocation?: DelegatedRunInvocation;
    readonly stopped?: boolean;
  },
): ReadonlyArray<ProviderRuntimeEvent> {
  const item = asCommandItemEvent(event);
  if (!item) {
    return [];
  }
  const data = asRecord(item.payload.data);
  if (isBackgroundShellItem(data)) {
    return [];
  }
  const command = commandFromItemData(data);
  const invocation =
    (command ? parseDelegatedRunCommand(command) : undefined) ?? options.invocation;
  if (!invocation) {
    return [];
  }
  const toolUseId = String(item.itemId);
  const taskId = RuntimeTaskId.make(`${invocation.provider}-run:${toolUseId}`);
  const linkage = taskLinkage(invocation, toolUseId);
  const events: ProviderRuntimeEvent[] = [];
  const base = {
    provider: item.provider,
    ...(item.providerInstanceId !== undefined
      ? { providerInstanceId: item.providerInstanceId }
      : {}),
    threadId: item.threadId,
    createdAt: item.createdAt,
    ...(item.turnId !== undefined ? { turnId: item.turnId } : {}),
  };
  const push = (
    event:
      | { type: "task.started"; payload: TaskStartedEvent["payload"] }
      | { type: "task.completed"; payload: TaskCompletedEvent["payload"] },
  ) => {
    // Keep the legacy start identity, but key child events by identity instead of
    // output order. Cancellation and completion share one parent terminal receipt.
    const suffix =
      event.payload.taskId === taskId
        ? event.type === "task.started"
          ? "00000001"
          : "99999999"
        : `00000002:${JSON.stringify(event.payload.taskId)}:${event.type === "task.started" ? "1" : "2"}`;
    events.push({
      ...base,
      eventId:
        event.type === "task.completed" && event.payload.taskId === taskId
          ? delegatedRunTerminalEventId(item, invocation)
          : EventId.make(
              `${invocation.provider}-run:${JSON.stringify([item.threadId, item.turnId ?? null, toolUseId])}:${suffix}`,
            ),
      ...event,
    });
  };
  if (!options.started) {
    push({
      type: "task.started",
      payload: {
        taskId,
        ...(invocation.prompt ? { description: invocation.prompt } : {}),
        ...linkage,
      },
    });
  }
  if (item.type !== "item.completed") {
    return events;
  }
  const output = outputFromItemData(data);
  const parsed =
    invocation.jsonOutput && output
      ? parseDelegatedRunOutput(invocation.provider, output)
      : { children: [], summary: output?.trim() || undefined, usage: undefined, failed: false };
  for (const child of parsed.children) {
    const childTaskId = RuntimeTaskId.make(`${taskId}:${child.id}`);
    const childLinkage = {
      taskType: "subagent",
      title: child.title ?? child.id,
      ...(child.role ? { role: child.role } : {}),
      ...(child.model ? { model: child.model } : {}),
      toolUseId,
    } as const;
    push({
      type: "task.started",
      payload: {
        taskId: childTaskId,
        ...(child.title ? { description: child.title } : {}),
        ...childLinkage,
      },
    });
    push({
      type: "task.completed",
      payload: {
        taskId: childTaskId,
        status: child.failed ? "failed" : "completed",
        ...(child.summary ? { summary: child.summary } : {}),
        ...childLinkage,
      },
    });
  }
  const exitCode =
    asRecord(data?.item)?.exitCode ??
    data?.exitCode ??
    asRecord(asRecord(data?.state)?.metadata)?.exit ??
    asRecord(data?.rawOutput)?.exitCode;
  const itemFailed =
    item.payload.status === "failed" ||
    item.payload.status === "declined" ||
    (typeof exitCode === "number" && exitCode !== 0) ||
    asRecord(data?.result)?.is_error === true ||
    asRecord(data?.state)?.status === "error";
  push({
    type: "task.completed",
    payload: {
      taskId,
      status: options.stopped ? "stopped" : itemFailed || parsed.failed ? "failed" : "completed",
      ...(parsed.summary ? { summary: parsed.summary } : {}),
      ...(parsed.usage ? { typedUsage: parsed.usage } : {}),
      ...linkage,
      ...("model" in parsed && parsed.model ? { model: parsed.model } : {}),
    },
  });
  return events;
}

/** Retain the invocation when later shell lifecycle events omit their original input. */
export function delegatedRunInvocation(
  event: ProviderRuntimeEvent,
): DelegatedRunInvocation | undefined {
  const item = asCommandItemEvent(event);
  if (!item) return undefined;
  const data = asRecord(item.payload.data);
  if (isBackgroundShellItem(data)) return undefined;
  const command = commandFromItemData(data);
  return command ? parseDelegatedRunCommand(command) : undefined;
}

/**
 * A parent has one terminal receipt, regardless of child output, turn omissions,
 * or cancellation. "terminal" sorts after the "[" start/child prefix at equal timestamps.
 */
export function delegatedRunTerminalEventId(
  event: ProviderRuntimeEvent,
  invocation: DelegatedRunInvocation,
): EventId {
  return EventId.make(
    `${invocation.provider}-run:terminal:${JSON.stringify([event.threadId, event.itemId])}`,
  );
}
