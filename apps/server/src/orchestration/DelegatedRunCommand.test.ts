import { describe, expect, it } from "vite-plus/test";
import { parseDelegatedRunCommand as parse } from "./DelegatedRunCommand.ts";

describe("parseDelegatedRunCommand", () => {
  it.each([
    [
      "opencode run --format json -m vendor/model 'hello'",
      "opencode",
      "hello",
      "vendor/model",
      true,
    ],
    ["codex exec --json -m gpt-model 'hello'", "codex", "hello", "gpt-model", true],
    ["codex -p profile e 'hello'", "codex", "hello", undefined, false],
    [
      "claude -p --model sonnet --output-format stream-json 'hello'",
      "claude",
      "hello",
      "sonnet",
      true,
    ],
    ["agent --print --model model --output-format json 'hello'", "cursor", "hello", "model", true],
    ["cursor-agent -p 'hello'", "cursor", "hello", undefined, false],
    [
      "grok --single 'hello' -m grok-model --output-format streaming-json",
      "grok",
      "hello",
      "grok-model",
      true,
    ],
  ])("recognizes %s", (command, provider, prompt, model, jsonOutput) => {
    expect(parse(command as string)).toEqual({
      provider,
      prompt,
      model,
      jsonOutput,
      agent: undefined,
    });
  });
  it.each([
    `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'opencode run --dir "C:\\work" --format json "hello"'`,
    `pwsh -NoLogo -NoProfile -NonInteractive -Command 'opencode run --format json "hello"'`,
    `powershell -ExecutionPolicy Bypass -Command "opencode run --format json 'hello'"`,
    `bash --noprofile --norc -lc "opencode run --format json 'hello'"`,
    `cmd.exe /d /s /c "opencode run --format json hello"`,
    `& 'C:\\tools\\opencode.ps1' run --format json 'hello'`,
  ])("unwraps %s", (command) => {
    expect(parse(command)).toMatchObject({
      provider: "opencode",
      prompt: "hello",
      jsonOutput: true,
    });
  });
  it.each([
    "echo opencode run fake",
    "grep codex exec .",
    "echo 'claude -p fake'",
    "cat <<EOF\nopencode run fake\nEOF",
    "# codex exec fake",
    "opencode run fake &",
    "bash -c 'codex exec fake' | cat &",
    "claude -p --background fake",
    "opencode run --help",
    "codex exec help",
    "grok --help -p fake",
    "claude --model '-p' fake",
    "agent --model '--print' fake",
    "powershell -Command '$text = @\"\nopencode run fake\n\"@'",
    "pwsh -c '<# comment\nopencode run fake\n#>'",
    "echo $(echo data\nopencode run fake)",
    "echo `echo data\ncodex exec fake`",
    "claude mcp -p fake",
    "powershell -File script.ps1 -Command 'opencode run fake'",
    "bash script.sh -c 'codex exec fake'",
    "cmd /k echo /c opencode run fake",
    "env --help opencode run fake",
    "command -v opencode run fake",
    "opencode run 'unterminated",
    "-x opencode run fake",
    "123 opencode run fake",
  ])("rejects data or detached invocations: %s", (command) => {
    expect(parse(command)).toBeUndefined();
  });
  it("handles PowerShell call operators, escaping, and literal backslashes", () => {
    expect(parse(`pwsh -c '& "C:\\Program Files\\codex.exe" exec --json "hello"'`)).toMatchObject({
      provider: "codex",
      prompt: "hello",
      jsonOutput: true,
    });
    expect(parse(`pwsh -c "claude -p 'it''s fine'"`)?.prompt).toBe("it's fine");
  });
  it.each([
    [`cmd /d /s /c '"C:\\Program Files\\opencode.cmd" run "hello world"'`, "hello world"],
    ['pwsh -Command \'opencode run "hello `"world`""\'', 'hello "world"'],
    [`powershell -Command opencode run --format json hello`, "hello"],
    [`pwsh -Command '$env:FOO = "bar"; & "C:\\tools\\opencode.exe" run hello'`, "hello"],
    [`cmd /c "echo before & opencode run hello"`, "hello"],
    [`cmd /d /s /c ""C:\\Program Files\\opencode.cmd" run "hello world""`, "hello world"],
  ])("preserves shell argument boundaries for %s", (command, prompt) => {
    expect(parse(command)).toMatchObject({ provider: "opencode", prompt });
  });
  it("recognizes a foreground invocation after a detached one", () => {
    expect(parse("codex exec ignored & claude -p real")?.prompt).toBe("real");
  });
  it.each([
    "opencode run one; codex exec two",
    "claude -p one && grok -p two",
    "bash -c 'opencode run one; claude -p two'",
    "bash -c 'opencode run one; claude -p two'; codex exec three",
  ])("rejects mixed output from multiple delegated runs: %s", (command) => {
    expect(parse(command)).toBeUndefined();
  });
  it("does not present session ids or stdin markers as prompts", () => {
    expect(parse("codex exec resume session-id 'continue work'")?.prompt).toBe("continue work");
    expect(parse("codex exec resume --last 'continue work'")?.prompt).toBe("continue work");
    expect(parse("codex exec -")?.prompt).toBeUndefined();
  });
});
