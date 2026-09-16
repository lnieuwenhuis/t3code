import type { RuntimeTaskUsage } from "@t3tools/contracts";
import type { DelegatedRunInvocation } from "./DelegatedRunCommand.ts";

export interface DelegatedRunChild {
  readonly id: string;
  readonly title: string | undefined;
  readonly role: string | undefined;
  readonly model: string | undefined;
  readonly failed: boolean;
  readonly summary: string | undefined;
}

export interface DelegatedRunOutput {
  readonly children: ReadonlyArray<DelegatedRunChild>;
  readonly summary: string | undefined;
  readonly usage: RuntimeTaskUsage | undefined;
  readonly failed: boolean;
  readonly model?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Accept both a pretty-printed result and JSONL mixed with CLI diagnostics. */
function records(output: string): Record<string, unknown>[] {
  try {
    const whole = record(JSON.parse(output));
    if (whole) return [whole];
  } catch {
    // Streaming output and diagnostic prefixes are decoded one line at a time.
  }
  const result: Record<string, unknown>[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("{")) continue;
    try {
      const value = record(JSON.parse(line));
      if (value) result.push(value);
    } catch {
      // A truncated or non-JSON diagnostic line carries no structured evidence.
    }
  }
  return result;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return text(value);
  if (!Array.isArray(value)) return undefined;
  return text(
    value
      .map((block) => {
        const item = record(block);
        return item?.type === "text" ? (text(item.text) ?? "") : "";
      })
      .filter(Boolean)
      .join("\n"),
  );
}

function childSummary(value: unknown): string | undefined {
  const output = text(value);
  if (!output) return undefined;
  return text(
    /^<task[^>]*>\s*(?:<summary>[\s\S]*?<\/summary>\s*)?<task_(?:result|error)>\s*([\s\S]*?)\s*<\/task_(?:result|error)>\s*<\/task>\s*$/.exec(
      output,
    )?.[1] ??
      /^task_id:[^\r\n]*\r?\n\s*<task_result>\s*([\s\S]*?)\s*<\/task_result>\s*$/.exec(
        output,
      )?.[1] ??
      output,
  );
}

function parseOpenCode(events: ReadonlyArray<Record<string, unknown>>): DelegatedRunOutput {
  const steps = new Map<string, Record<string, unknown>>();
  const tools = new Map<string, Record<string, unknown>>();
  let summary: string | undefined;
  let failed = false;
  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;
  for (const event of events) {
    const timestamp = count(event.timestamp);
    if (timestamp !== undefined) {
      firstTimestamp = Math.min(firstTimestamp ?? timestamp, timestamp);
      lastTimestamp = Math.max(lastTimestamp ?? timestamp, timestamp);
    }
    const part = record(event.part);
    if (event.type === "error") {
      failed = true;
      const error = record(event.error);
      summary =
        text(record(error?.data)?.message) ??
        text(error?.message) ??
        text(record(event.data)?.message) ??
        text(event.message) ??
        summary;
    }
    if (!part) continue;
    const identity = text(part.id) ?? JSON.stringify(event);
    if (event.type === "step_finish") {
      const tokens = record(part.tokens);
      if (tokens) steps.set(identity, tokens);
      // A completed generation after a transient error is successful evidence.
      if (part.reason === "stop") failed = false;
    } else if (event.type === "text") {
      summary = text(part.text) ?? summary;
    } else if (event.type === "tool_use") {
      tools.set(text(part.callID) ?? identity, part);
    }
  }
  const children = new Map<string, DelegatedRunChild>();
  for (const [key, part] of tools) {
    if (part.tool !== "task") continue;
    const state = record(part.state) ?? {};
    if (state.status !== "completed" && state.status !== "error") continue;
    const input = record(state.input) ?? {};
    const metadata = record(state.metadata) ?? {};
    const model = record(metadata.model);
    const modelId = text(model?.modelID);
    const providerId = text(model?.providerID);
    const id = text(metadata.sessionId) ?? text(part.callID) ?? key;
    children.set(id, {
      id,
      title: text(input.description) ?? text(state.title),
      role: text(input.subagent_type),
      model: modelId ? (providerId ? `${providerId}/${modelId}` : modelId) : undefined,
      failed: state.status === "error",
      summary: childSummary(state.error ?? state.output),
    });
  }
  let usage: RuntimeTaskUsage | undefined;
  if (steps.size > 0) {
    let totalTokens = 0,
      inputTokens = 0,
      cachedInputTokens = 0,
      outputTokens = 0,
      reasoningOutputTokens = 0;
    for (const tokens of steps.values()) {
      const input = count(tokens.input) ?? 0;
      const cached = count(record(tokens.cache)?.read) ?? 0;
      const output = count(tokens.output) ?? 0;
      const reasoning = count(tokens.reasoning) ?? 0;
      inputTokens += input;
      cachedInputTokens += cached;
      outputTokens += output;
      reasoningOutputTokens += reasoning;
      totalTokens += count(tokens.total) ?? input + cached + output + reasoning;
    }
    usage = {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      toolUses: tools.size,
      ...(firstTimestamp !== undefined && lastTimestamp !== undefined
        ? { durationMs: lastTimestamp - firstTimestamp }
        : {}),
    };
  }
  return { children: [...children.values()], summary, usage, failed };
}

function parseCodex(events: ReadonlyArray<Record<string, unknown>>): DelegatedRunOutput {
  let summary: string | undefined;
  let usage: RuntimeTaskUsage | undefined;
  let failed = false;
  for (const event of events) {
    if (event.type === "item.completed") {
      const item = record(event.item);
      if (item?.type === "agent_message") summary = text(item.text) ?? summary;
    } else if (event.type === "turn.completed") {
      failed = false;
      const tokens = record(event.usage);
      if (!tokens) continue;
      const inputTokens = count(tokens.input_tokens);
      const outputTokens = count(tokens.output_tokens);
      if (inputTokens === undefined && outputTokens === undefined) continue;
      usage = {
        totalTokens: count(tokens.total_tokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(count(tokens.cached_input_tokens) !== undefined
          ? { cachedInputTokens: count(tokens.cached_input_tokens)! }
          : {}),
        ...(count(tokens.reasoning_output_tokens) !== undefined
          ? { reasoningOutputTokens: count(tokens.reasoning_output_tokens)! }
          : {}),
      };
    } else if (event.type === "turn.failed" || event.type === "error") {
      failed = true;
      summary = text(record(event.error)?.message) ?? text(event.message) ?? summary;
    }
  }
  return { children: [], summary, usage, failed };
}

function parseResultStream(
  events: ReadonlyArray<Record<string, unknown>>,
  claude: boolean,
): DelegatedRunOutput {
  const children = new Map<string, DelegatedRunChild>();
  const completedChildren = new Set<string>();
  const taskIdByTool = new Map<string, string>();
  const backgroundTools = new Set<string>();
  let summary: string | undefined;
  let model: string | undefined;
  let usage: RuntimeTaskUsage | undefined;
  let failed = false;
  for (const event of events) {
    // Forwarded child messages must not overwrite the enclosing run's result.
    if (text(event.parent_tool_use_id)) continue;
    const content = record(event.message)?.content;
    if (claude && Array.isArray(content)) {
      for (const value of content) {
        const block = record(value);
        if (!block) continue;
        if (
          event.type === "assistant" &&
          block.type === "tool_use" &&
          (block.name === "Agent" || block.name === "Task")
        ) {
          const toolId = text(block.id);
          if (!toolId) continue;
          const id = taskIdByTool.get(toolId) ?? toolId;
          const input = record(block.input) ?? {};
          if (input.run_in_background === true) backgroundTools.add(toolId);
          const previous = children.get(id);
          children.set(id, {
            id,
            title: text(input.description) ?? previous?.title,
            role: text(input.subagent_type) ?? previous?.role,
            model: text(input.model) ?? previous?.model,
            failed: previous?.failed ?? false,
            summary: previous?.summary,
          });
        } else if (event.type === "user" && block.type === "tool_result") {
          const toolId = text(block.tool_use_id);
          if (!toolId || backgroundTools.has(toolId)) continue;
          const id = taskIdByTool.get(toolId) ?? toolId;
          const previous = children.get(id);
          if (!previous) continue;
          completedChildren.add(id);
          children.set(id, {
            ...previous,
            failed: block.is_error === true,
            summary: contentText(block.content) ?? previous.summary,
          });
        }
      }
    }
    if (event.type === "system" && event.subtype === "init") model = text(event.model) ?? model;
    if (
      claude &&
      event.type === "system" &&
      (event.subtype === "task_started" || event.subtype === "task_notification")
    ) {
      const id = text(event.task_id);
      if (!id) continue;
      const toolId = text(event.tool_use_id);
      const previous = children.get(id) ?? (toolId ? children.get(toolId) : undefined);
      if (toolId) {
        taskIdByTool.set(toolId, id);
        if (toolId !== id) {
          children.delete(toolId);
          if (completedChildren.delete(toolId)) completedChildren.add(id);
        }
      }
      if (
        event.subtype === "task_notification" &&
        ["completed", "failed", "stopped"].includes(String(event.status))
      )
        completedChildren.add(id);
      children.set(id, {
        id,
        title: text(event.description) ?? previous?.title,
        role: previous?.role,
        model: previous?.model,
        failed: event.status === "failed" || event.status === "stopped",
        summary: text(event.summary) ?? previous?.summary,
      });
    } else if (event.type === "assistant") {
      summary = contentText(record(event.message)?.content) ?? summary;
    } else if (event.type === "result") {
      failed =
        event.is_error === true ||
        (typeof event.subtype === "string" && event.subtype.startsWith("error"));
      const errors = Array.isArray(event.errors)
        ? event.errors.map(text).filter(Boolean).join("\n")
        : undefined;
      summary = text(event.result) ?? text(errors) ?? summary;
      const tokens = record(event.usage);
      if (!tokens) continue;
      const input = count(tokens.input_tokens);
      const output = count(tokens.output_tokens);
      if (input === undefined && output === undefined) continue;
      const cached = count(tokens.cache_read_input_tokens) ?? 0;
      const created = count(tokens.cache_creation_input_tokens) ?? 0;
      usage = {
        totalTokens: count(tokens.total_tokens) ?? (input ?? 0) + cached + created + (output ?? 0),
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(output !== undefined ? { outputTokens: output } : {}),
        cachedInputTokens: cached,
        ...(count(event.duration_ms) !== undefined
          ? { durationMs: count(event.duration_ms)! }
          : {}),
      };
    } else if (event.type === "error") {
      failed = true;
      summary = text(record(event.error)?.message) ?? text(event.message) ?? summary;
    }
  }
  return {
    children: [...children.values()].filter((child) => completedChildren.has(child.id)),
    summary,
    usage,
    failed,
    ...(model ? { model } : {}),
  };
}

/** Grok's native JSON and streaming-json share terminal spend fields. */
function parseGrok(events: ReadonlyArray<Record<string, unknown>>): DelegatedRunOutput {
  if (events.some((event) => event.type === "result")) return parseResultStream(events, false);
  let streamedText = "";
  let summary: string | undefined;
  let usage: RuntimeTaskUsage | undefined;
  let failed = false;
  for (const event of events) {
    if (event.type === "text" && typeof event.data === "string") streamedText += event.data;
    if (event.type === "error") {
      failed = true;
      summary = text(event.message) ?? summary;
    }
    if (event.type !== "end" && event.type !== "error" && typeof event.stopReason !== "string")
      continue;
    // Per-response usage is included in the final aggregate; never sum both.
    if (event.type === "usage") continue;
    if (typeof event.stopReason === "string") {
      failed = ["error", "cancelled", "max_tokens", "max_turn_requests", "refusal"].includes(
        event.stopReason,
      );
      summary = text(event.text) ?? text(streamedText) ?? summary;
    }
    const tokens = record(event.usage);
    if (!tokens) continue;
    const inputTokens = count(tokens.input_tokens);
    const outputTokens = count(tokens.output_tokens);
    if (inputTokens === undefined && outputTokens === undefined) continue;
    const cachedInputTokens = count(tokens.cache_read_input_tokens) ?? 0;
    usage = {
      totalTokens:
        count(tokens.total_tokens) ??
        (inputTokens ?? 0) +
          cachedInputTokens +
          (count(tokens.cache_creation_input_tokens) ?? 0) +
          (outputTokens ?? 0),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      cachedInputTokens,
      ...(count(tokens.reasoning_tokens) !== undefined
        ? { reasoningOutputTokens: count(tokens.reasoning_tokens)! }
        : {}),
    };
  }
  return { children: [], summary: summary ?? text(streamedText), usage, failed };
}

/** Provider stdout formats, deliberately separate from shell result envelopes. */
export function parseDelegatedRunOutput(
  provider: DelegatedRunInvocation["provider"],
  output: string,
): DelegatedRunOutput {
  const events = records(output);
  if (events.length === 0) {
    // Early startup/auth diagnostics can precede JSON mode. Keep prose, but
    // leave status to the shell exit code and never display truncated JSON as
    // an assistant answer or infer a successful protocol completion from it.
    const diagnostic = text(output);
    const looksLikeJson = output.split(/\r?\n/).some((line) => /^\s*[{[]/.test(line));
    return {
      children: [],
      summary:
        looksLikeJson || /^(?:null|true|false|\d+)$/.test(diagnostic ?? "")
          ? undefined
          : diagnostic,
      usage: undefined,
      failed: false,
    };
  }
  switch (provider) {
    case "opencode":
      return parseOpenCode(events);
    case "codex":
      return parseCodex(events);
    case "claude":
      return parseResultStream(events, true);
    case "cursor":
      return parseResultStream(events, false);
    case "grok":
      return parseGrok(events);
  }
}
