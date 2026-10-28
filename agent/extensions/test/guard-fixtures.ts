import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

import { echoedText, type Printer } from "../../lib/command-input.ts";
import hostGuardExtension from "../host-guard.ts";
import { extensionTestAdapter, unsafeFixture } from "./adapter.ts";

// Role prompts the subagents launcher passes, and the argv of each kind of Pi session. A role
// prompt's directory under system/generated/ is its kind.

export const DELEGATE_PROMPT = "/h/.pi/agent/system/generated/delegate/implementer.md";

export const OWNER_PROMPT = "/h/.pi/agent/system/generated/owner/babysitter.md";

export const rootArgv = ["node", "pi"];

export const delegateArgv = [
  "node",
  "pi",
  "--print",
  "--system-prompt",
  DELEGATE_PROMPT,
  "--no-skills",
];

export const ownerArgv = ["node", "pi", "--print", "--system-prompt", OWNER_PROMPT, "--no-skills"];

// A `tool_call` handler blocks with `{ block: true, reason }` and lets a call run with `undefined`.
export const Refusal = Schema.Struct({ block: Schema.Literal(true), reason: Schema.String });

export type Refusal = typeof Refusal.Type;

export const decodeDecision = Schema.decodeUnknownSync(Schema.UndefinedOr(Refusal));

// Host guard calls, as an agent session makes them through the extension.

const sessions = [rootArgv, ownerArgv, delegateArgv];

const commandTools = ["bash", "bg_start"] as const;

interface AgentCall {
  readonly argv: readonly string[];
  readonly toolName: (typeof commandTools)[number];
  readonly command: string;
}

function withLaunchArgv<T>(argv: readonly string[], run: () => T): T {
  const launchArgv = process.argv;
  process.argv = [...argv];

  try {
    return run();
  } finally {
    process.argv = launchArgv;
  }
}

export async function guardDecision(argv: readonly string[], event: ToolCallEvent) {
  const result = await withLaunchArgv(argv, () => {
    const adapter = extensionTestAdapter();
    hostGuardExtension(adapter.api);

    return adapter.emit("tool_call", event, unsafeFixture<ExtensionContext>({}));
  });

  return decodeDecision(result);
}

function agentCall({ argv, toolName, command }: AgentCall): Promise<Refusal | undefined> {
  return guardDecision(argv, {
    type: "tool_call",
    toolCallId: "call-1",
    toolName,
    input: { command },
  });
}

export function assertKillRefused(refusal: Refusal | undefined, label: string): void {
  assert.ok(refusal, `${label} is refused`);
  assert.match(refusal.reason, /\bbg_kill\b/, `${label}: the reason names bg_kill`);
  assert.match(refusal.reason, /a PID you started/, `${label}: the reason names a PID you started`);
}

export function assertTmpGlobRefused(refusal: Refusal | undefined, label: string): void {
  assert.ok(refusal, `${label} is refused`);
  assert.match(refusal.reason, /exact path/, `${label}: the reason names deleting by exact path`);
  // Each bash call is a new shell, so the fix must not depend on a variable set in an earlier call.
  assert.match(
    refusal.reason,
    /the path mktemp printed/,
    `${label}: the reason names mktemp's path`,
  );
  assert.doesNotMatch(refusal.reason, /\$\w/, `${label}: the reason names no shell variable`);
}

export function assertPrintfRefused(refusal: Refusal | undefined, label: string): void {
  assert.ok(refusal, `${label} is refused`);
  assert.match(
    refusal.reason,
    /cannot read what this printf prints/,
    `${label}: the reason names printf`,
  );
  assert.match(refusal.reason, /quoted heredoc/, `${label}: the reason names a quoted heredoc`);
}

export function assertRuns(refusal: Refusal | undefined, label: string): void {
  assert.equal(refusal, undefined, `${label} runs`);
}

export async function assertEach(
  calls: readonly AgentCall[],
  assertion: (refusal: Refusal | undefined, label: string) => void,
): Promise<void> {
  const decisions = await Promise.all(calls.map(agentCall));

  calls.forEach((call, index) => {
    assertion(decisions[index], `${call.toolName} ${call.command} (argv ${call.argv.join(" ")})`);
  });
}

export function rootBash(commands: readonly string[]): AgentCall[] {
  return commands.map((command) => ({ argv: rootArgv, toolName: "bash", command }));
}

export function everySession(commands: readonly string[]): AgentCall[] {
  return sessions.flatMap((argv) =>
    commandTools.flatMap((toolName) => commands.map((command) => ({ argv, toolName, command }))),
  );
}

export function assertEchoRefused(refusal: Refusal | undefined, label: string): void {
  assert.ok(refusal, `${label} is refused`);
  assert.match(
    refusal.reason,
    /cannot read what this echo prints/,
    `${label}: the reason names echo`,
  );
  assert.match(refusal.reason, /quoted heredoc/, `${label}: the reason names a quoted heredoc`);
}

export function assertAnsiCRefused(refusal: Refusal | undefined, label: string): void {
  assert.ok(refusal, `${label} is refused`);
  assert.match(refusal.reason, /ANSI-C quoted/, `${label}: the reason names the quoting`);
  assert.match(refusal.reason, /quoted heredoc/, `${label}: the reason names a quoted heredoc`);
}

/** An assertion that a call is refused unread, with a reason that names the word form. */
export function assertUnreadWordRefused(
  form: RegExp,
): (refusal: Refusal | undefined, label: string) => void {
  return (refusal, label) => {
    assert.ok(refusal, `${label} is refused`);
    assert.match(
      refusal.reason,
      /cannot read this/,
      `${label}: the reason says the guard cannot read it`,
    );
    assert.match(refusal.reason, form, `${label}: the reason names the form`);
  };
}

export function assertNestingRefused(refusal: Refusal | undefined, label: string): void {
  assert.ok(refusal, `${label} is refused`);
  assert.match(refusal.reason, /64 levels/, `${label}: the reason names the limit`);
  assert.match(refusal.reason, /[Ss]plit it/, `${label}: the reason says to split the command`);
}

export function nested(open: string, body: string, close: string, depth: number): string {
  return `${open.repeat(depth)}${body}${close.repeat(depth)}`;
}

// Literal printf and echo forms whose text the host guard must read as real printf and
// echo print it.

export const PRINTF_FORMS: readonly (readonly string[])[] = [
  ["%s", "pkill x"],
  ["%s\\n", "true", "pkill x"],
  ["%s %s\\n", "a", "b", "c"],
  ["echo %s\\n", "pkill x"],
  ["100%% done\\n%s\\n", "pkill x"],
  ["%%s", "A"],
  ["%b", "true\\npkill x"],
  ["%b", "\\x70kill x"],
  ["%b", "\\160kill x"],
  ["%b", "\\0160kill x"],
  ["%b", "\\01600"],
  ["%b", "rm -rf /tmp/aa-\\x2a"],
  ["\\160kill x"],
  ["\\x70kill\\x20x"],
  ["\\x700"],
  ["\\0160kill"],
  ['\\a\\b\\e\\f\\n\\r\\t\\v\\\\\\"'],
  ["%b", "\\a\\b\\e\\f\\n\\r\\t\\v\\\\"],
  ["%b", "\\x7g\\x2z"],
  ["%b%s", "echo hi\\c", "; pkill x"],
  ["%s%b%s", "a", "b\\cc", "d"],
  ["\\x25s", "A"],
  ["\\q\\z\\ \\$\\8"],
  ["%b", "\\q\\9\\8\\0101"],
  ["%s"],
  ["%b %s", "a"],
  ["x", " y"],
  ["\\377\\x41"],
];

export const ECHO_FORMS: readonly (readonly string[])[] = [
  ["pkill x"],
  ["a", "b"],
  ["-n", "pkill x"],
  ["-e", "\\x70kill x"],
  ["-e", "\\0160kill x"],
  ["-en", "true\\npkill x"],
  ["-e", "\\a\\b\\e\\f\\n\\r\\t\\v\\\\"],
  ["-e", "\\x7g\\x2z\\x\\x700"],
  ["-e", "\\q\\?\\%\\'\\\"\\8\\9"],
  ["-e", "echo hi\\c", "; pkill x"],
  ["-e", "\\01601\\0377"],
  ["-E", "a b"],
  ["-eE", "a b"],
  ["-Ee", "a\\tb"],
  ["-e", "-n", "a\\tb"],
  ["--", "-e"],
  ["-"],
  ["-x", "a"],
  [],
];

// What printf or echo prints, run alone with no shell reading its output: bash's builtin,
// then coreutils'. The environment holds only PATH, so no BASH_ENV startup file prints
// before they do.
function realOutputs(printer: Printer, args: readonly string[]): readonly string[] {
  const options = { env: { PATH: process.env["PATH"] ?? "" } };
  const bashArgs = ["--norc", "--noprofile", "-c", `${printer} "$@"`, printer, ...args];

  const [builtin, coreutils] = [
    spawnSync("bash", bashArgs, options),
    spawnSync(`/usr/bin/${printer}`, args, options),
  ];

  return [builtin.stdout.toString("latin1"), coreutils.stdout.toString("latin1")];
}

export function assertReadAsPrinted(printer: Printer, forms: readonly (readonly string[])[]): void {
  for (const form of forms) {
    const read = echoedText([printer, ...form]);
    const label = `${printer} ${form.map((word) => JSON.stringify(word)).join(" ")}`;

    assert.ok(read?.readable, `${label}: the guard reads it`);

    for (const printed of realOutputs(printer, form)) assert.equal(read.text, printed, label);
  }
}
