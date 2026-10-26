import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import hostGuardExtension from "../host-guard.ts";
import { extensionTestAdapter, unsafeFixture } from "./adapter.ts";
import {
  type Refusal,
  decodeDecision,
  delegateArgv,
  ownerArgv,
  rootArgv,
} from "./guard-fixtures.ts";

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
  // Each bash call is a new shell, so the fix must not depend on a variable set in an earlier call.
  assert.match(
    refusal.reason,
    /the path mktemp printed/,
    `${label}: the reason names mktemp's path`,
  );
  assert.doesNotMatch(refusal.reason, /\$\w/, `${label}: the reason names no shell variable`);
}

function assertRuns(refusal: Refusal | undefined, label: string): void {
  assert.equal(refusal, undefined, `${label} runs`);
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
      "pidof node | xargs kill",
      "kill $(ps -C node -o pid=)",
      "pgrep -f x | xargs -n 1 kill",
      "pgrep -f x | xargs -rI{} timeout 5 kill {}",
      "(pgrep -f x) | xargs kill",
      "kill $(echo $(pgrep -f x))",
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

test("every agent session refuses a pattern kill and a /tmp glob delete, from bash and bg_start alike", async () => {
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
    assertRuns,
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
    assertRuns,
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
    assertRuns,
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

test("a kill or delete inside a command substitution is refused", async () => {
  await assertEach(
    rootBash([
      'echo "$(pkill -f vitest)"',
      "echo $(pkill -f vitest)",
      "echo `pkill -f vitest`",
      "printf '%s' \"$(killall java)\"",
      'echo "`pkill node`"',
      "x=$(pkill -f y)",
      'bash -c "echo hi" "$(pkill -f vitest)"',
      "bash -c 'echo $(pkill -f vitest)'",
      "diff <(pkill -f x) f",
      "cat <<EOF\n$(pkill -f x)\nEOF",
      "echo $(( $(pkill -f x) + 1 ))",
      "echo $((1 << 2))\npkill node",
    ]),
    assertKillRefused,
  );
  await assertEach(rootBash(["echo $(rm -rf /tmp/aa-*)"]), assertTmpGlobRefused);
  await assertEach(
    everySession([
      "echo '$(pkill -f vitest)'",
      "grep -n '`killall java`' notes.md",
      'echo "$(cat pids.txt)"',
      "cat <<'EOF'\n$(pkill -f x)\nEOF",
      'grep -n "$(printf "%s" "a; pkill -f vitest")" notes.md',
    ]),
    assertRuns,
  );
});

test("a kill or delete after a subshell, brace, or reserved word is refused", async () => {
  await assertEach(
    rootBash([
      "(pkill -f vitest)",
      "{ pkill -f vitest; }",
      "if true; then pkill -f vitest; fi",
      "if ! pgrep -f x; then :; else killall java; fi",
      "while true; do pkill node; done",
      "until false; do pkill node; done",
      'for f in a b; do pkill -f "$f"; done',
      "! pkill node",
      "bash -c '(pkill -f vitest)'",
      "stop() { pkill -f vitest; }",
      "function stop { pkill -f vitest; }",
      "case $x in a) pkill -f vitest;; esac",
      "time pkill node",
    ]),
    assertKillRefused,
  );
  await assertEach(
    rootBash(["(rm -rf /tmp/aa-*)", "{ cd /x && rm -rf /tmp/tmp.*/w; }", "rm -rf /tmp/@(aa|bb)*"]),
    assertTmpGlobRefused,
  );
  await assertEach(
    everySession([
      'for f in pkill killall; do echo "$f"; done',
      "names=(pkill killall)",
      "if grep -q 'pkill -f' notes.md; then echo found; fi",
      "{ echo '(pkill -f vitest)'; }",
    ]),
    assertRuns,
  );
});

test("a PID search feeds xargs kill only through the same pipeline", async () => {
  await assertEach(
    everySession([
      "pgrep -af vitest; cat pids.txt | xargs kill",
      "pgrep -af vitest && cat pids.txt | xargs kill",
      "pgrep -af vitest\ncat pids.txt | xargs kill",
      "pgrep -af vitest | xargs echo kill",
      "pgrep -af vitest | xargs -I kill echo kill",
    ]),
    assertRuns,
  );
});

test("a shell's -c operand is read after long options that take an argument", async () => {
  await assertEach(
    rootBash(["bash --rcfile x -c 'pkill y'", "bash --norc --init-file x -c 'killall java'"]),
    assertKillRefused,
  );
  await assertEach(rootBash(["bash --rcfile x script.sh pkill"]), assertRuns);
});

test("a kill run through command or builtin is refused", async () => {
  await assertEach(
    everySession([
      "command pkill -f vitest",
      "command -p pkill -f vitest",
      'builtin kill "$(pgrep -f vitest)"',
    ]),
    assertKillRefused,
  );
});

test("a kill or delete run through sudo or doas is refused, past their options", async () => {
  await assertEach(
    everySession([
      "sudo pkill -f vitest",
      "sudo -u x pkill -f vitest",
      "sudo -- pkill -f vitest",
      "sudo -E -g staff killall java",
      "sudo -nu x pkill node",
      "sudo --user x pkill node",
      "sudo --user=x pkill node",
      'sudo -u x kill "$(pgrep -f vitest)"',
      "doas pkill -f vitest",
      "doas -u x pkill -f vitest",
    ]),
    assertKillRefused,
  );
  await assertEach(
    everySession(["sudo -u x rm -rf /tmp/aa-*", "doas -u x rm -rf /tmp/tmp.*/w"]),
    assertTmpGlobRefused,
  );
});

test("a kill or delete in env's split string, or past env's options, is refused", async () => {
  await assertEach(
    everySession([
      'env -S "pkill -f vitest"',
      "env -S'pkill -f vitest'",
      'env -iS "pkill node"',
      'env --split-string="pkill -f vitest"',
      'env --split-string "killall java"',
      'env -S "pkill -f" vitest',
      'env -S "-u FOO" pkill node',
      'sudo env -S "pkill -f vitest"',
      "env -u FOO pkill node",
      "env -C /repo killall java",
    ]),
    assertKillRefused,
  );
  await assertEach(everySession(['env -S "rm -rf /tmp/aa-*"']), assertTmpGlobRefused);
  await assertEach(everySession(['env -S "kill 12345"', "env -u FOO grep -n pkill f"]), assertRuns);
});

test("a lookup of a kill command runs", async () => {
  await assertEach(
    everySession(["command -v pkill", "command -V killall", "command -pv pkill", "type pkill"]),
    assertRuns,
  );
});

test("an array assignment with an operator inside is judged without hanging", async () => {
  await assertEach(rootBash(["arr=(a>b) && pkill node"]), assertKillRefused);
  await assertEach(rootBash(["arr=(a;b|c&d<e"]), assertRuns);
});
