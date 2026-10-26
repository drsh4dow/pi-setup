import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

import hostGuardExtension from "../host-guard.ts";
import { extensionTestAdapter, unsafeFixture } from "./adapter.ts";

const UNATTENDED = "/h/.pi/agent/skills/subagents/unattended.md";

const OWNER = "/h/.pi/agent/skills/subagents/owner.md";

const DELEGATE = "/h/.pi/agent/skills/subagents/delegate.md";

const rootArgv = ["node", "pi"];

const delegateArgv = [
  "node",
  "pi",
  "--print",
  "--append-system-prompt",
  UNATTENDED,
  "--append-system-prompt",
  DELEGATE,
];

const ownerArgv = [
  "node",
  "pi",
  "--print",
  "--append-system-prompt",
  UNATTENDED,
  "--append-system-prompt",
  OWNER,
];

const sessions = [rootArgv, ownerArgv, delegateArgv];

const commandTools = ["bash", "bg_start"] as const;

// A `tool_call` handler blocks with `{ block: true, reason }` and lets a call run with `undefined`.
const Refusal = Schema.Struct({ block: Schema.Literal(true), reason: Schema.String });

type Refusal = typeof Refusal.Type;

const decodeDecision = Schema.decodeUnknownSync(Schema.UndefinedOr(Refusal));

interface AgentCall {
  readonly argv: readonly string[];
  readonly toolName: (typeof commandTools)[number];
  readonly command: string;
}

// Runs `run` in a Pi process launched with `argv`, restoring the real argv before it yields.
function withLaunchArgv<T>(argv: readonly string[], run: () => T): T {
  const launchArgv = process.argv;
  process.argv = [...argv];

  try {
    return run();
  } finally {
    process.argv = launchArgv;
  }
}

async function guardDecision(argv: readonly string[], event: ToolCallEvent) {
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

function assertKillRefused(refusal: Refusal | undefined, label: string): void {
  assert.ok(refusal, `${label} is refused`);
  assert.match(refusal.reason, /\bbg_kill\b/, `${label}: the reason names bg_kill`);
  assert.match(refusal.reason, /a PID you started/, `${label}: the reason names a PID you started`);
}

function assertTmpGlobRefused(refusal: Refusal | undefined, label: string): void {
  assert.ok(refusal, `${label} is refused`);
  assert.match(refusal.reason, /exact path/, `${label}: the reason names deleting by exact path`);
}

async function assertEach(
  calls: readonly AgentCall[],
  assertion: (refusal: Refusal | undefined, label: string) => void,
): Promise<void> {
  const decisions = await Promise.all(calls.map(agentCall));

  calls.forEach((call, index) => {
    assertion(decisions[index], `${call.toolName} ${call.command} (argv ${call.argv.join(" ")})`);
  });
}

function rootBash(commands: readonly string[]): AgentCall[] {
  return commands.map((command) => ({ argv: rootArgv, toolName: "bash", command }));
}

function everySession(commands: readonly string[]): AgentCall[] {
  return sessions.flatMap((argv) =>
    commandTools.flatMap((toolName) => commands.map((command) => ({ argv, toolName, command }))),
  );
}

const KILL_BY_PATTERN = [
  'pkill -f "vitest run"',
  "pkill node",
  "killall java",
  "kill $(pgrep -f vitest)",
];

const TMP_GLOB_DELETES = ["rm -rf /tmp/aa-*", "rm -rf /tmp/tmp.*/w"];

test("a kill by name is refused, pointing at bg_kill and a PID you started", async () => {
  await assertEach(
    rootBash([
      'pkill -f "vitest run"',
      "pkill node",
      "killall java",
      "timeout 5 /usr/bin/pkill x",
      "\\pkill -f vitest",
      "echo don\\'t # it's a comment\npkill -f vitest",
      'grep -c a <<< "$notes"\npkill -f vitest',
    ]),
    assertKillRefused,
  );
});

test("a kill of the PIDs a name search found is refused", async () => {
  await assertEach(
    rootBash([
      "kill $(pgrep -f vitest)",
      'kill -9 "$(pgrep -f "vitest run")"',
      "kill `pidof node`",
      "pgrep -f vitest | xargs kill",
      "ps aux | grep vitest | awk '{print $2}' | xargs -r kill -9",
    ]),
    assertKillRefused,
  );
});

test("a glob delete under /tmp is refused, pointing at the exact path you created", async () => {
  await assertEach(
    rootBash([
      "rm -rf /tmp/aa-*",
      "rm -rf /tmp/tmp.*/w",
      "rm -r -f /tmp/vps-?",
      "rm /tmp/[ab]-run.log",
      "cd /repo && rm -rf -- /tmp/x /tmp/pi-*",
    ]),
    assertTmpGlobRefused,
  );
});

test("every agent session refuses them, from bash and bg_start alike", async () => {
  await assertEach(everySession(KILL_BY_PATTERN), assertKillRefused);
  await assertEach(everySession(TMP_GLOB_DELETES), assertTmpGlobRefused);
});

test("targeted kills, deletes, and reads run", async () => {
  await assertEach(
    everySession([
      "kill 12345",
      'kill "$pid"',
      "kill -TERM -- -4242",
      "kill $(cat server.pid)",
      "cat pids.txt | xargs kill",
      'rm -rf "$scratch"',
      "rm -rf /tmp/demo-xyz",
      "rm -f ./build/*.log",
      "pgrep -af vitest",
      "grep -n 'pkill -f' notes.md",
      "rg -n 'killall|rm -rf /tmp/' docs",
      "ps aux | grep vitest",
    ]),
    (refusal, label) => {
      assert.equal(refusal, undefined, `${label} runs`);
    },
  );
});

test("a quoted kill or delete string is a search pattern, not a command", async () => {
  await assertEach(
    everySession([
      'rg "foo; pkill -f b" .',
      "grep -n 'a; pkill -f b' f",
      "grep -nE 'x|pkill y' f",
      'echo "done && killall java"',
      'echo "a \\"; pkill -f b\\" c"',
      "grep -n 'x; rm -rf /tmp/aa-*' notes.md",
      "ls # then; pkill -f b",
    ]),
    (refusal, label) => {
      assert.equal(refusal, undefined, `${label} runs`);
    },
  );
});

test("a kill or delete inside a bash -c, sh -c, zsh -c, or eval string is refused", async () => {
  await assertEach(
    rootBash([
      "bash -c 'pkill -f vitest'",
      'sh -c "cd /repo && kill \\$(pgrep -f vitest)"',
      "timeout 60 bash -lc 'killall java'",
      "bash -o pipefail -c 'pgrep -f x | xargs kill'",
      "/bin/zsh -c \"bash -c 'pkill node'\"",
      'eval "pkill -f vitest"',
    ]),
    assertKillRefused,
  );
  await assertEach(
    rootBash(["zsh -c 'rm -rf /tmp/aa-*'", 'eval "cd /x; rm -rf /tmp/tmp.*/w"']),
    assertTmpGlobRefused,
  );
  await assertEach(
    rootBash([
      "bash -c \"grep -n 'a; pkill -f b' f\"",
      "bash -c 'kill 12345'",
      "bash script.sh pkill",
      "ssh host 'echo hi'",
    ]),
    (refusal, label) => {
      assert.equal(refusal, undefined, `${label} runs`);
    },
  );
});

test("a codemode script's nested bash call is refused like a direct one", async () => {
  const refusal = await guardDecision(rootArgv, {
    type: "tool_call",
    toolCallId: "call-1/1",
    parentToolCallId: "call-1",
    toolName: "bash",
    input: { command: "pkill -f vitest" },
  });

  assertKillRefused(refusal, "nested pkill -f vitest");
});

test("a tool that runs no command is not judged by its text", async () => {
  const refusal = await guardDecision(rootArgv, {
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "write",
    input: { path: "notes.md", content: "never run pkill -f vitest or rm -rf /tmp/aa-*" },
  });

  assert.equal(refusal, undefined);
});
