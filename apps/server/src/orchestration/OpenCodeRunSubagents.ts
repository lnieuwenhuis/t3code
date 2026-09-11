import {
  EventId,
  RuntimeTaskId,
  type ProviderRuntimeEvent,
  type RuntimeTaskUsage,
} from "@t3tools/contracts";

/**
 * Bridges `opencode run` invocations made through a provider's shell tool
 * (Claude's Bash, Codex's exec, ACP execute) into task.* runtime events, so a
 * thread that delegates to OpenCode from another provider shows the delegated
 * run and its native subagents in the Agents panel and sidebar liveness.
 *
 * The shell tool is the only signal: the run itself starts when the command
 * item starts and settles when the item completes. When the command asked
 * for `--format json`, the captured output also yields the run's token usage,
 * its final text, and one settled child per OpenCode `task` tool call.
 */

export interface OpenCodeRunInvocation {
  readonly prompt: string | undefined;
  readonly model: string | undefined;
  readonly agent: string | undefined;
  readonly jsonOutput: boolean;
}

interface ShellToken {
  readonly text: string;
  readonly quoted: boolean;
}

const MAX_PROMPT_LENGTH = 200;
const MAX_NESTED_COMMAND_DEPTH = 2;
const COMMAND_SEPARATOR = /^(\|\|?|&&|;|&)$/;
const REDIRECT_PREFIX = /^\d*[<>]/;
const REDIRECT_WITH_OPERAND = /^\d*(>>?|<)$/;
const VALUE_OPTIONS = new Set([
  "-m",
  "--model",
  "--agent",
  "--variant",
  "-s",
  "--session",
  "--format",
  "--command",
  "--dir",
  "--attach",
  "-p",
  "--password",
  "-u",
  "--username",
  "--log-level",
  "-f",
  "--file",
]);
// yargs treats these as optional-value options: the next token is only the
// value when it does not look like another option.
const OPTIONAL_VALUE_OPTIONS = new Set(["--title", "--port"]);

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let text = "";
  let quoted = false;
  let inToken = false;
  let quote: '"' | "'" | null = null;
  const flush = () => {
    if (inToken) {
      tokens.push({ text, quoted });
    }
    text = "";
    quoted = false;
    inToken = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        text += char;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && index + 1 < command.length) {
        index += 1;
        const next = command[index]!;
        if (next !== "\n") {
          text += next;
        }
      } else {
        text += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      inToken = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index += 1;
      const next = command[index]!;
      if (next !== "\n") {
        text += next;
        inToken = true;
      }
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    text += char;
    inToken = true;
  }
  flush();
  return tokens;
}

function executableName(token: ShellToken): string | undefined {
  if (token.quoted) {
    return undefined;
  }
  const slash = token.text.lastIndexOf("/");
  return slash === -1 ? token.text : token.text.slice(slash + 1);
}

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SHELL_COMMAND_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;

/** `zsh -lc "<script>"` style wrappers, as Codex and some hooks spawn them. */
function isShellWrapperScript(tokens: ReadonlyArray<ShellToken>, index: number): boolean {
  const flag = tokens[index - 1];
  const shell = tokens[index - 2];
  return (
    tokens[index]!.quoted &&
    flag !== undefined &&
    !flag.quoted &&
    SHELL_COMMAND_FLAG.test(flag.text) &&
    shell !== undefined &&
    SHELL_EXECUTABLES.has(executableName(shell) ?? "")
  );
}

function normalizePrompt(parts: ReadonlyArray<string>): string | undefined {
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  // Command substitutions and heredocs carry no readable prompt.
  if (joined.length === 0 || joined.includes("$(") || joined.includes("`")) {
    return undefined;
  }
  return joined.length > MAX_PROMPT_LENGTH
    ? `${joined.slice(0, MAX_PROMPT_LENGTH - 3)}...`
    : joined;
}

function parseInvocationTokens(tokens: ReadonlyArray<ShellToken>): OpenCodeRunInvocation {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  let optionsEnded = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.quoted) {
      if (COMMAND_SEPARATOR.test(token.text)) {
        break;
      }
      if (REDIRECT_PREFIX.test(token.text)) {
        if (REDIRECT_WITH_OPERAND.test(token.text)) {
          index += 1;
        }
        continue;
      }
    }
    if (optionsEnded || token.quoted || !token.text.startsWith("-")) {
      positionals.push(token.text);
      continue;
    }
    if (token.text === "--") {
      optionsEnded = true;
      continue;
    }
    const equals = token.text.indexOf("=");
    const name = equals === -1 ? token.text : token.text.slice(0, equals);
    if (equals !== -1) {
      options.set(name, token.text.slice(equals + 1));
      continue;
    }
    const next = tokens[index + 1];
    if (VALUE_OPTIONS.has(name)) {
      if (next !== undefined) {
        options.set(name, next.text);
        index += 1;
      }
      continue;
    }
    if (OPTIONAL_VALUE_OPTIONS.has(name) && next !== undefined && !next.text.startsWith("-")) {
      index += 1;
    }
  }
  const model = options.get("-m") ?? options.get("--model");
  const agent = options.get("--agent");
  return {
    prompt: normalizePrompt(positionals),
    model: model && model.length > 0 ? model : undefined,
    agent: agent && agent.length > 0 ? agent : undefined,
    jsonOutput: options.get("--format") === "json",
  };
}

/**
 * Recognizes an `opencode run …` invocation anywhere in a shell command line,
 * including behind `cd … &&`, env assignments, or a wrapper such as
 * `zsh -lc "opencode run …"`.
 */
export function parseOpenCodeRunCommand(
  command: string,
  depth = 0,
): OpenCodeRunInvocation | undefined {
  if (!command.includes("opencode")) {
    return undefined;
  }
  const tokens = tokenizeShell(command);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const next = tokens[index + 1]!;
    if (executableName(tokens[index]!) === "opencode" && !next.quoted && next.text === "run") {
      return parseInvocationTokens(tokens.slice(index + 2));
    }
  }
  if (depth >= MAX_NESTED_COMMAND_DEPTH) {
    return undefined;
  }
  for (let index = 2; index < tokens.length; index += 1) {
    if (isShellWrapperScript(tokens, index)) {
      const nested = parseOpenCodeRunCommand(tokens[index]!.text, depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
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
    asString(asRecord(data.item)?.command)
  );
}

function isBackgroundShellItem(data: Record<string, unknown> | undefined): boolean {
  return asRecord(data?.input)?.run_in_background === true;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((block) => asString(asRecord(block)?.text))
      .filter((value): value is string => value !== undefined)
      .join("\n");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

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
    return textFromContent(resultRecord.content);
  }
  const item = asRecord(data.item);
  if (item) {
    return asString(item.aggregatedOutput);
  }
  const rawOutput = data.rawOutput;
  if (typeof rawOutput === "string") {
    return rawOutput;
  }
  const rawOutputRecord = asRecord(rawOutput);
  return (
    asString(rawOutputRecord?.stdout) ??
    asString(rawOutputRecord?.output) ??
    textFromContent(data.content)
  );
}

interface OpenCodeRunChild {
  readonly id: string;
  readonly title: string | undefined;
  readonly role: string | undefined;
  readonly model: string | undefined;
  readonly failed: boolean;
  readonly summary: string | undefined;
}

interface OpenCodeRunOutput {
  readonly children: ReadonlyArray<OpenCodeRunChild>;
  readonly summary: string | undefined;
  readonly usage: RuntimeTaskUsage | undefined;
  readonly failed: boolean;
}

const TASK_OUTPUT_WRAPPER =
  /^<task[^>]*>\s*(?:<summary>[\s\S]*?<\/summary>\s*)?<task_(?:result|error)>\s*([\s\S]*?)\s*<\/task_(?:result|error)>\s*<\/task>\s*$/;

function childSummary(output: unknown, error: unknown): string | undefined {
  const text = asString(error) ?? asString(output);
  if (!text) {
    return undefined;
  }
  const unwrapped = TASK_OUTPUT_WRAPPER.exec(text)?.[1] ?? text;
  const trimmed = unwrapped.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function childFromTaskPart(part: Record<string, unknown>, fallbackId: string): OpenCodeRunChild {
  const state = asRecord(part.state) ?? {};
  const input = asRecord(state.input) ?? {};
  const metadata = asRecord(state.metadata) ?? {};
  const model = asRecord(metadata.model);
  const modelId = asString(model?.modelID);
  const providerId = asString(model?.providerID);
  const description = asString(input.description)?.trim();
  const title = asString(state.title)?.trim();
  return {
    id: asString(metadata.sessionId) ?? asString(part.callID) ?? fallbackId,
    title: description || title || undefined,
    role: asString(input.subagent_type)?.trim() || undefined,
    model: modelId ? (providerId ? `${providerId}/${modelId}` : modelId) : undefined,
    failed: state.status === "error",
    summary: childSummary(state.output, state.error),
  };
}

/** Folds the raw JSON event lines printed by `opencode run --format json`. */
export function parseOpenCodeRunOutput(output: string): OpenCodeRunOutput {
  const children: OpenCodeRunChild[] = [];
  let summary: string | undefined;
  let failed = false;
  let steps = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let toolUses = 0;
  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(trimmed));
    } catch {
      continue;
    }
    const type = asString(event?.type);
    if (!event || !type) {
      continue;
    }
    const timestamp = asNonNegativeInt(event.timestamp);
    if (timestamp !== undefined) {
      firstTimestamp ??= timestamp;
      lastTimestamp = timestamp;
    }
    const part = asRecord(event.part);
    switch (type) {
      case "step_finish": {
        const tokens = asRecord(part?.tokens);
        if (!tokens) {
          break;
        }
        steps += 1;
        const input = asNonNegativeInt(tokens.input) ?? 0;
        const cached = asNonNegativeInt(asRecord(tokens.cache)?.read) ?? 0;
        const outputCount = asNonNegativeInt(tokens.output) ?? 0;
        const reasoning = asNonNegativeInt(tokens.reasoning) ?? 0;
        inputTokens += input;
        cachedInputTokens += cached;
        outputTokens += outputCount;
        reasoningTokens += reasoning;
        totalTokens += asNonNegativeInt(tokens.total) ?? input + cached + outputCount + reasoning;
        break;
      }
      case "text": {
        const text = asString(part?.text)?.trim();
        if (text) {
          summary = text;
        }
        break;
      }
      case "tool_use": {
        toolUses += 1;
        if (part && part.tool === "task") {
          children.push(childFromTaskPart(part, `task-${children.length + 1}`));
        }
        break;
      }
      case "error": {
        failed = true;
        break;
      }
      default:
        break;
    }
  }
  const usage: RuntimeTaskUsage | undefined =
    steps > 0
      ? {
          totalTokens,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningOutputTokens: reasoningTokens,
          toolUses,
          ...(firstTimestamp !== undefined && lastTimestamp !== undefined
            ? { durationMs: lastTimestamp - firstTimestamp }
            : {}),
        }
      : undefined;
  return { children, summary, usage, failed };
}

type TaskStartedEvent = Extract<ProviderRuntimeEvent, { type: "task.started" }>;
type TaskCompletedEvent = Extract<ProviderRuntimeEvent, { type: "task.completed" }>;
type CommandItemEvent = Extract<
  ProviderRuntimeEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;

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
export function openCodeRunItemKey(event: ProviderRuntimeEvent): string | undefined {
  const item = asCommandItemEvent(event);
  return item ? `${item.threadId}:${item.itemId}` : undefined;
}

function taskLinkage(invocation: OpenCodeRunInvocation, toolUseId: string) {
  return {
    taskType: "subagent",
    title: invocation.prompt ?? "opencode run",
    role: invocation.agent ?? "opencode",
    ...(invocation.model ? { model: invocation.model } : {}),
    toolUseId,
  } as const;
}

/**
 * Derives the task.* events an `opencode run` shell item implies. `started`
 * tells whether this item's run already has a task.started; the caller owns
 * that memory because a Claude Bash item streams its input across several
 * item.updated events before the command is readable.
 */
export function deriveOpenCodeRunEvents(
  event: ProviderRuntimeEvent,
  options: { readonly started: boolean },
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
  const invocation = command ? parseOpenCodeRunCommand(command) : undefined;
  if (!invocation) {
    return [];
  }
  const toolUseId = String(item.itemId);
  const taskId = RuntimeTaskId.make(`opencode-run:${toolUseId}`);
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
    events.push({
      ...base,
      eventId: EventId.make(`${item.eventId}:opencode-run:${events.length + 1}`),
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
      ? parseOpenCodeRunOutput(output)
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
  const itemFailed = item.payload.status === "failed" || item.payload.status === "declined";
  push({
    type: "task.completed",
    payload: {
      taskId,
      status: itemFailed || parsed.failed ? "failed" : "completed",
      ...(parsed.summary ? { summary: parsed.summary } : {}),
      ...(parsed.usage ? { typedUsage: parsed.usage } : {}),
      ...linkage,
    },
  });
  return events;
}
