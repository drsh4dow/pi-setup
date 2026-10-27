import assert from "node:assert/strict";

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

import hostGuardExtension from "../host-guard.ts";
import { extensionTestAdapter, unsafeFixture } from "./adapter.ts";

// The kind files the subagents skill appends, and the argv of each kind of Pi session.

export const UNATTENDED = "/h/.pi/agent/skills/subagents/unattended.md";

export const OWNER = "/h/.pi/agent/skills/subagents/owner.md";

export const DELEGATE = "/h/.pi/agent/skills/subagents/delegate.md";

export const rootArgv = ["node", "pi"];

export const delegateArgv = [
  "node",
  "pi",
  "--print",
  "--append-system-prompt",
  UNATTENDED,
  "--append-system-prompt",
  DELEGATE,
];

export const ownerArgv = [
  "node",
  "pi",
  "--print",
  "--append-system-prompt",
  UNATTENDED,
  "--append-system-prompt",
  OWNER,
];

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
