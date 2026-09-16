export interface DelegatedRunInvocation {
  readonly provider: "opencode" | "codex" | "claude" | "cursor" | "grok";
  readonly prompt: string | undefined;
  readonly model: string | undefined;
  readonly agent: string | undefined;
  readonly jsonOutput: boolean;
}

interface ShellToken {
  readonly text: string;
  readonly quoted: boolean;
  readonly assignment?: boolean;
}

const MAX_PROMPT_LENGTH = 200;
const MAX_NESTED_COMMAND_DEPTH = 4;
type ShellDialect = "posix" | "powershell" | "cmd";
const AMBIGUOUS_RUNS = Symbol("ambiguous delegated runs");
type CommandResult = DelegatedRunInvocation | typeof AMBIGUOUS_RUNS | undefined;
const COMMAND_SEPARATOR = /^(\|[|&]?|&&|;|&)$/;
const REDIRECT_PREFIX = /^(?:\d*[<>]|&>)/;
const REDIRECT_WITH_OPERAND = /^(?:\d*(>>?|<|<<-?|<<<|[<>]&)|&>>?)$/;
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

/** Splits a command line into words, honoring quotes, escapes, and separators. */
function tokenizeShell(command: string, dialect: ShellDialect): ShellToken[] {
  const tokens: ShellToken[] = [];
  let text = "";
  let quoted = false;
  let inToken = false;
  let assignment = false;
  let quote: '"' | "'" | null = null;
  const hereDocuments: Array<{ delimiter: string; stripTabs: boolean }> = [];
  let awaitingHereDocument: { stripTabs: boolean } | undefined;
  const flush = () => {
    if (inToken) {
      tokens.push({ text, quoted, assignment });
      if (awaitingHereDocument) {
        hereDocuments.push({ delimiter: text, ...awaitingHereDocument });
        awaitingHereDocument = undefined;
      }
    }
    text = "";
    quoted = false;
    inToken = false;
    assignment = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'" && dialect === "powershell" && command[index + 1] === "'") {
        text += "'";
        index += 1;
      } else if (char === "'") {
        quote = null;
      } else {
        text += char;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (
        ((dialect === "posix" && char === "\\" && /["$`\\\n]/.test(command[index + 1] ?? "")) ||
          (dialect === "powershell" && char === "`")) &&
        index + 1 < command.length
      ) {
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
    if (dialect === "powershell" && char === "<" && command[index + 1] === "#") {
      const end = command.indexOf("#>", index + 2);
      index = end === -1 ? command.length : end + 1;
      continue;
    }
    // Substitution contents are another execution context; never attribute
    // their command-looking data to the outer command's lifetime.
    if (char === "$" && command[index + 1] === "(") {
      let nesting = 1;
      let end = index + 2;
      for (; end < command.length && nesting > 0; end += 1) {
        if (command[end] === "(") nesting += 1;
        if (command[end] === ")") nesting -= 1;
      }
      text += command.slice(index, end);
      inToken = true;
      quoted = true;
      index = end - 1;
      continue;
    }
    if (dialect === "posix" && char === "`") {
      const end = command.indexOf("`", index + 1);
      text += command.slice(index, end === -1 ? command.length : end + 1);
      inToken = true;
      quoted = true;
      index = end === -1 ? command.length : end;
      continue;
    }
    // PowerShell here-strings are data, including any command-looking lines.
    if (
      dialect === "powershell" &&
      char === "@" &&
      /['"]/.test(command[index + 1] ?? "") &&
      /\r?\n/.test(command.slice(index + 2, index + 4))
    ) {
      const delimiter = command[index + 1] + "@";
      const end = command.indexOf("\n" + delimiter, index + 2);
      text += "<here-string>";
      inToken = true;
      quoted = true;
      index = end === -1 ? command.length : end + delimiter.length;
      continue;
    }
    if ((char === "'" && dialect !== "cmd") || char === '"') {
      quote = char;
      quoted = true;
      inToken = true;
      continue;
    }
    if (
      ((dialect === "posix" && char === "\\" && !/^[A-Za-z]:/.test(text)) ||
        (dialect === "powershell" && char === "`") ||
        (dialect === "cmd" && char === "^")) &&
      index + 1 < command.length
    ) {
      index += 1;
      const next = command[index]!;
      if (next !== "\n") {
        text += next;
        quoted = true;
        inToken = true;
      }
      continue;
    }
    // A hash begins a comment only outside quotes and at a word boundary.
    // Leave the newline for normal command/heredoc processing.
    if (char === "#" && !inToken) {
      const newline = command.indexOf("\n", index);
      index = newline === -1 ? command.length : newline - 1;
      continue;
    }
    if (char === "\n") {
      flush();
      tokens.push({ text: ";", quoted: false });
      // Bodies begin after the command line, in redirect order. Their contents
      // are input data, not shell commands; quote removal already decoded each
      // delimiter in flush(). An unfinished body consumes the remaining input.
      for (const { delimiter, stripTabs } of hereDocuments) {
        let start = index + 1;
        while (start < command.length) {
          const newline = command.indexOf("\n", start);
          const end = newline === -1 ? command.length : newline;
          const line = command.slice(start, end);
          index = end;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) {
            break;
          }
          start = end + 1;
        }
      }
      hereDocuments.length = 0;
      continue;
    }
    if (char === "<" || char === ">") {
      // Only an unquoted all-digit word immediately before the operator is
      // a file descriptor; quoted digits remain ordinary command arguments.
      const descriptor = inToken && !quoted && /^\d+$/.test(text) ? text : "";
      if (descriptor) {
        inToken = false;
      }
      flush();
      const next = command[index + 1];
      const suffix = command[index + 2];
      const operator =
        char === "<" && next === "<"
          ? suffix === "<"
            ? "<<<"
            : suffix === "-"
              ? "<<-"
              : "<<"
          : next === char || next === "&"
            ? char + next
            : char;
      tokens.push({ text: descriptor + operator, quoted: false });
      if (operator === "<<" || operator === "<<-") {
        awaitingHereDocument = { stripTabs: operator === "<<-" };
      }
      index += operator.length - 1;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (char === "&" && command[index + 1] === ">") {
      flush();
      const append = command[index + 2] === ">";
      tokens.push({ text: append ? "&>>" : "&>", quoted: false });
      index += append ? 2 : 1;
      continue;
    }
    // Separators need no surrounding whitespace (`ls;opencode run`, `… |head`);
    // `&` stays attached inside redirects such as `2>&1`.
    if (char === ";" || char === "|" || (char === "&" && !text.endsWith(">"))) {
      flush();
      const next = command[index + 1];
      const paired = char !== ";" && (next === char || (char === "|" && next === "&"));
      tokens.push({ text: paired ? char + next : char, quoted: false });
      if (paired) {
        index += 1;
      }
      continue;
    }
    if (char === "=" && !quoted && /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
      assignment = true;
    }
    text += char;
    inToken = true;
  }
  if (quote !== null) return [];
  flush();
  return tokens;
}

/** Redirections belong to the shell, not the executable's option arguments. */
function withoutShellRedirects(tokens: ReadonlyArray<ShellToken>): ShellToken[] {
  const words: ShellToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.quoted && REDIRECT_PREFIX.test(token.text)) {
      const next = tokens[index + 1];
      if (
        REDIRECT_WITH_OPERAND.test(token.text) &&
        next &&
        (next.quoted || !COMMAND_SEPARATOR.test(next.text))
      ) {
        index += 1;
      }
    } else {
      words.push(token);
    }
  }
  return words;
}

/** Executable basename after shell quote removal. */
function executableName(token: ShellToken): string | undefined {
  return token.text
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
}

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
// Wrappers that run their trailing argv as the real command.
const TRANSPARENT_WRAPPERS = new Set(["env", "exec", "nohup", "time", "timeout", "command"]);

/** An asynchronous shell list cannot mirror the delegated run's lifetime. */
function isBackgroundShellList(tokens: ReadonlyArray<ShellToken>, start = 0): boolean {
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]!;
    if (!token.quoted && token.text === "&") {
      return true;
    }
    if (!token.quoted && token.text === ";") {
      return false;
    }
  }
  return false;
}

/** Joins positional words into a compact prompt, or nothing when it is not readable. */
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

const PROVIDER_VALUE_OPTIONS = {
  opencode: VALUE_OPTIONS,
  codex: new Set([
    "-m",
    "--model",
    "-c",
    "--config",
    "--enable",
    "--disable",
    "-i",
    "--image",
    "--local-provider",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-C",
    "--cd",
    "--add-dir",
    "--thread-source",
    "--output-schema",
    "--color",
    "-o",
    "--output-last-message",
    "-a",
    "--ask-for-approval",
    "--base",
    "--commit",
    "--title",
  ]),
  claude: new Set([
    "--model",
    "--agent",
    "--agents",
    "--append-system-prompt",
    "--append-system-prompt-file",
    "--system-prompt",
    "--system-prompt-file",
    "--output-format",
    "--input-format",
    "--json-schema",
    "--max-budget-usd",
    "--max-turns",
    "--permission-mode",
    "--permission-prompt-tool",
    "--fallback-model",
    "--settings",
    "--setting-sources",
    "--session-id",
    "--effort",
    "--debug-file",
    "-n",
    "--name",
    "--plugin-dir",
    "--plugin-url",
  ]),
  cursor: new Set(["--model", "--output-format", "--resume", "--workspace", "--api-key"]),
  grok: new Set([
    "-m",
    "--model",
    "-p",
    "--single",
    "-s",
    "--session-id",
    "--cwd",
    "--output-format",
    "--prompt-json",
    "--prompt-file",
    "--rules",
    "--tools",
    "--disallowed-tools",
    "--max-turns",
    "--reasoning-effort",
    "--effort",
    "--permission-mode",
    "--allow",
    "--deny",
    "--sandbox",
    "--agent",
    "--agents",
  ]),
};
const CLAUDE_VARIADIC_OPTIONS = new Set([
  "--add-dir",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--tools",
  "--mcp-config",
  "--betas",
  "--file",
]);
const CLAUDE_OPTIONAL_OPTIONS = new Set([
  "-r",
  "--resume",
  "-d",
  "--debug",
  "--from-pr",
  "--worktree",
  "-w",
  "--prompt-suggestions",
]);

function parseInvocation(
  tokens: ReadonlyArray<ShellToken>,
  provider: DelegatedRunInvocation["provider"],
): DelegatedRunInvocation | undefined {
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (optionsEnded || !token.text.startsWith("-") || token.text === "-") {
      positionals.push(token.text);
      continue;
    }
    if (token.text === "--") {
      optionsEnded = true;
      continue;
    }
    const equals = token.text.indexOf("=");
    const name = equals === -1 ? token.text : token.text.slice(0, equals);
    flags.add(name);
    if (equals !== -1) {
      options.set(name, token.text.slice(equals + 1));
      continue;
    }
    const next = tokens[index + 1];
    if (PROVIDER_VALUE_OPTIONS[provider].has(name)) {
      if (next) {
        options.set(name, next.text);
        index += 1;
      }
    } else if (
      (provider === "opencode" && OPTIONAL_VALUE_OPTIONS.has(name)) ||
      (provider === "claude" && CLAUDE_OPTIONAL_OPTIONS.has(name))
    ) {
      if (next && !next.text.startsWith("-")) {
        options.set(name, next.text);
        index += 1;
      }
    } else if (provider === "claude" && CLAUDE_VARIADIC_OPTIONS.has(name)) {
      while (tokens[index + 1] && !tokens[index + 1]!.text.startsWith("-")) index += 1;
    }
  }
  if (
    ["--help", "-h", "--version", "-V"].some((flag) => flags.has(flag)) ||
    (provider !== "codex" && flags.has("-v"))
  )
    return undefined;
  if (provider === "opencode" && (flags.has("--interactive") || flags.has("-i"))) return undefined;
  if (
    provider === "claude" &&
    [
      "auth",
      "mcp",
      "agents",
      "install",
      "update",
      "doctor",
      "plugin",
      "plugins",
      "attach",
      "logs",
      "stop",
      "rm",
      "setup-token",
    ].includes(positionals[0] ?? "")
  )
    return undefined;
  if (
    provider === "claude" &&
    ["--bg", "--background", "--cloud", "--remote-control"].some((flag) => flags.has(flag))
  )
    return undefined;
  if ((provider === "claude" || provider === "cursor") && !flags.has("-p") && !flags.has("--print"))
    return undefined;
  if (
    provider === "grok" &&
    !["-p", "--single", "--prompt-json", "--prompt-file"].some((flag) => flags.has(flag))
  )
    return undefined;
  if (provider === "codex") {
    if (positionals[0] === "help") return undefined;
    if (positionals[0] === "resume" || positionals[0] === "fork") {
      positionals.shift();
      if (!flags.has("--last")) positionals.shift();
    } else if (positionals[0] === "review") positionals.shift();
  }
  const prompt =
    provider === "grok" ? [options.get("-p") ?? options.get("--single") ?? ""] : positionals;
  return {
    provider,
    prompt: normalizePrompt(prompt.filter((part) => part !== "-")),
    model: options.get("--model") || options.get("-m") || undefined,
    agent: options.get("--agent") || undefined,
    jsonOutput:
      provider === "opencode"
        ? options.get("--format") === "json"
        : provider === "codex"
          ? flags.has("--json")
          : ["json", "stream-json", "streaming-json", "streaming-messages-json"].includes(
              options.get("--output-format") ?? "",
            ),
  };
}

/** Skip only known executable wrappers, never arbitrary options or data words. */
function commandStart(tokens: ReadonlyArray<ShellToken>, dialect: ShellDialect): number {
  let index = 0;
  if (dialect === "powershell" && tokens[index]?.text === "&" && !tokens[index]?.quoted) index += 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.assignment) {
      index += 1;
      continue;
    }
    const executable = executableName(token);
    if (!TRANSPARENT_WRAPPERS.has(executable ?? "")) break;
    index += 1;
    if (
      executable === "command" &&
      tokens.slice(index).some((word) => ["-v", "-V"].includes(word.text))
    )
      return tokens.length;
    while (tokens[index]?.text.startsWith("-")) {
      const flag = tokens[index++]!.text;
      if (["--help", "--version"].includes(flag)) return tokens.length;
      if (
        ["-u", "--unset", "-C", "--chdir", "-s", "--signal", "-k", "--kill-after", "-a"].includes(
          flag,
        )
      )
        index += 1;
    }
    if (executable === "timeout") {
      if (!/^\d+(\.\d+)?[smhd]?$/.test(tokens[index]?.text ?? "")) return tokens.length;
      index += 1;
    }
  }
  return index;
}

/** Command flags only count before a script filename or another execution mode. */
function shellCommandIndex(args: ReadonlyArray<ShellToken>, dialect: ShellDialect): number {
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!.text;
    if (dialect === "powershell") {
      if (/^-(?:c|command)$/i.test(flag)) return index;
      if (
        /^-(?:executionpolicy|ep|inputformat|outputformat|windowstyle|workingdirectory)$/i.test(
          flag,
        )
      ) {
        index += 1;
        continue;
      }
      if (!/^-(?:nologo|noprofile|noprofileloadtime|noninteractive|noexit|sta|mta)$/i.test(flag))
        return -1;
    } else if (dialect === "cmd") {
      if (/^\/c$/i.test(flag)) return index;
      if (!/^\/(?:[dqsau]|[evf]:(?:on|off))$/i.test(flag)) return -1;
    } else {
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag)) return index;
      if (["--rcfile", "--init-file", "-o", "-O"].includes(flag)) {
        index += 1;
        continue;
      }
      if (!flag.startsWith("-") || flag === "--") return -1;
    }
  }
  return -1;
}

function parseSimpleCommand(
  tokens: ReadonlyArray<ShellToken>,
  dialect: ShellDialect,
  depth: number,
): CommandResult {
  const start = commandStart(tokens, dialect);
  const binary = tokens[start];
  if (!binary) return undefined;
  const name = executableName(binary);
  const args = tokens.slice(start + 1);
  if (depth < MAX_NESTED_COMMAND_DEPTH) {
    if (SHELL_EXECUTABLES.has(name ?? "")) {
      const flag = shellCommandIndex(args, "posix");
      if (flag >= 0 && args[flag + 1])
        return parseCommand(args[flag + 1]!.text, "posix", depth + 1);
    }
    if (name === "powershell" || name === "pwsh") {
      const flag = shellCommandIndex(args, "powershell");
      if (flag >= 0 && args[flag + 1]) {
        const script = args.slice(flag + 1);
        return parseCommand(
          script.length === 1
            ? script[0]!.text
            : script
                .map((word) => (word.quoted ? `'${word.text.replaceAll("'", "''")}'` : word.text))
                .join(" "),
          "powershell",
          depth + 1,
        );
      }
    }
    if (name === "cmd") {
      const flag = shellCommandIndex(args, "cmd");
      if (flag >= 0 && args[flag + 1])
        return parseCommand(
          args
            .slice(flag + 1)
            .map((word) => word.text)
            .join(" "),
          "cmd",
          depth + 1,
        );
    }
  }
  if (name === "opencode" || name === "codex") {
    const valueOptions =
      name === "opencode" ? new Set(["--log-level"]) : PROVIDER_VALUE_OPTIONS.codex;
    let index = 0;
    while (args[index]?.text.startsWith("-")) {
      const option = args[index++]!.text;
      if (["--help", "-h", "--version", "-V", "-v"].includes(option)) return undefined;
      if (valueOptions.has(option)) index += 1;
    }
    if (
      name === "opencode"
        ? args[index]?.text !== "run"
        : !["exec", "e"].includes(args[index]?.text ?? "")
    )
      return undefined;
    return parseInvocation([...args.slice(0, index), ...args.slice(index + 1)], name);
  }
  if (name === "claude" || name === "grok") return parseInvocation(args, name);
  if (name === "cursor-agent" || name === "agent") return parseInvocation(args, "cursor");
  if (name === "cursor" && args[0]?.text === "agent")
    return parseInvocation(args.slice(1), "cursor");
  return undefined;
}

function parseCommand(command: string, dialect: ShellDialect, depth: number): CommandResult {
  // cmd /s /c strips the first and last quote of its command string. Preserve
  // that raw string before normal quote removal loses the inner argv quotes.
  const cmdWrapper =
    /^\s*("[^"]+"|'[^']+'|[^\s]+)(?:\s+\/(?:[dqsau]|[evf]:on|[evf]:off))*\s+\/c\s+([\s\S]+)$/i.exec(
      command,
    );
  if (
    depth < MAX_NESTED_COMMAND_DEPTH &&
    cmdWrapper &&
    executableName({ text: cmdWrapper[1]!.replace(/^['"]|['"]$/g, ""), quoted: false }) === "cmd"
  ) {
    const script = cmdWrapper[2]!.trim();
    const unwrapped = script.startsWith('"') && script.endsWith('"') ? script.slice(1, -1) : script;
    // Single quotes are a surrounding POSIX/PowerShell wrapper, not cmd syntax.
    if (!script.startsWith("'")) return parseCommand(unwrapped, "cmd", depth + 1);
  }
  const tokens = withoutShellRedirects(tokenizeShell(command, dialect));
  let start = 0;
  let found: DelegatedRunInvocation | undefined;
  for (let index = 0; index <= tokens.length; index += 1) {
    const token = tokens[index];
    const callOperator = dialect === "powershell" && index === start && token?.text === "&";
    if (token && (token.quoted || !COMMAND_SEPARATOR.test(token.text) || callOperator)) continue;
    if (index > start && (dialect === "cmd" || !isBackgroundShellList(tokens, index))) {
      const invocation = parseSimpleCommand(tokens.slice(start, index), dialect, depth);
      if (invocation === AMBIGUOUS_RUNS || (invocation && found)) return AMBIGUOUS_RUNS;
      if (invocation) found = invocation;
    }
    start = index + 1;
  }
  return found;
}

/** Recognize foreground headless CLI invocations without evaluating shell code. */
export function parseDelegatedRunCommand(command: string): DelegatedRunInvocation | undefined {
  const dialect =
    /^\s*&\s+/.test(command) || /\$env:|@['"]\r?\n/.test(command) ? "powershell" : "posix";
  const result = parseCommand(command, dialect, 0);
  return result === AMBIGUOUS_RUNS ? undefined : result;
}
