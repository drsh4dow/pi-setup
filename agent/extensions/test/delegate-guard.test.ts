import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import { extensionTestAdapter, unsafeFixture } from "./adapter.ts";
import runDelegateGuard, { spawnGuard } from "../delegate-guard.ts";

const skill = readFileSync(new URL("../../skills/subagents/SKILL.md", import.meta.url), "utf8");

const UNATTENDED = "/h/.pi/agent/skills/subagents/unattended.md";

const OWNER = "/h/.pi/agent/skills/subagents/owner.md";

const DELEGATE = "/h/.pi/agent/skills/subagents/delegate.md";

const DELEGATE_BLOCK = /^Delegates spawn nothing/;

const OWNER_BLOCK = /^Owners launch only delegates/;

function guardFor(argv: readonly string[]): (command: string) => string | undefined {
  const guard = spawnGuard(argv);
  assert.ok(guard, `a subagent launched with ${argv.join(" ")} gets a guard`);

  return guard;
}

const delegateArgv = ["node", "pi", "--print", "--append-system-prompt", UNATTENDED];

const ownerArgv = [...delegateArgv, "--append-system-prompt", OWNER];

test("the subagents skill's launch block starts a delegate, which an owner may run", () => {
  const launch = skill.match(/## Launch[\s\S]*?```bash\n([\s\S]*?)```/)?.[1];
  assert.ok(launch, "subagents SKILL.md has a bash launch block under ## Launch");

  const argv = launch
    .replaceAll("\\\n", " ")
    .replaceAll("$HOME", "/home/u")
    .split(/\s+/)
    .map((word) => word.replaceAll('"', ""));

  const asOwner = argv.map((word) => word.replace("subagents/delegate.md", "subagents/owner.md"));
  const ownerLaunch = launch.replace("subagents/delegate.md", "subagents/owner.md");

  assert.notEqual(ownerLaunch, launch, "the launch block appends delegate.md");
  assert.match(guardFor(argv)(launch) ?? "", DELEGATE_BLOCK, "a delegate may not spawn");
  assert.equal(guardFor(asOwner)(launch), undefined, "an owner may launch a delegate");
  assert.match(
    guardFor(asOwner)(ownerLaunch) ?? "",
    OWNER_BLOCK,
    "an owner may not launch an owner",
  );
});

test("a process without unattended.md is a root and gets no guard", () => {
  assert.equal(spawnGuard(["node", "pi"]), undefined);
  assert.equal(
    spawnGuard(["node", "pi", "--print", "--append-system-prompt", DELEGATE]),
    undefined,
  );
});

test("a subagent without owner.md is a delegate and spawns no pi print launch", () => {
  const delegateGuard = guardFor(delegateArgv);

  for (const command of [
    'pi -p "say ok"',
    'pi --print --no-session "say ok"',
    'cd /tmp/app && pi --model anthropic/claude-opus-5-5 --print "hi"',
    "/home/u/.bun/bin/pi --print <<'EOF'\nhi\nEOF",
    "FOO=1 pi \\\n  --thinking high \\\n  --print",
    `pi --print --append-system-prompt ${UNATTENDED} --append-system-prompt ${DELEGATE} "hi"`,
    `bash -c 'pi --print "hi"'`,
  ]) {
    assert.match(delegateGuard(command) ?? "", DELEGATE_BLOCK, command);
  }
});

test("commands that are not pi print launches pass", () => {
  const delegateGuard = guardFor(delegateArgv);
  const ownerGuard = guardFor(ownerArgv);

  for (const command of [
    "vp run verify",
    "mkdir -p pi",
    "pip install -p x",
    "git log -p",
    "ls ~/.pi/agent -p",
    "pi --help",
    "api --print",
    "rg -n pi-subagent agent",
    "grep -rn pi-subagent agent",
    "test -x .build/bin/pi-subagent",
    "grep -nE 'pi-subagent|pi --print' delegate-guard.ts",
    "grep -nE 'pi --print' delegate-guard.ts",
    'rg "foo; pi -p" .',
    "grep 'pi --print' delegate-guard.ts",
    "grep 'bash -c pi --print' delegate-guard.ts",
  ]) {
    assert.equal(delegateGuard(command), undefined, command);
    assert.equal(ownerGuard(command), undefined, command);
  }
});

test("the extension applies the same command guard to bash and bg_start", async () => {
  const originalArgv = process.argv;
  process.argv = [...delegateArgv];

  try {
    const extension = extensionTestAdapter();
    runDelegateGuard(extension.api);
    const context = unsafeFixture<ExtensionContext>({});
    const quotedCommand = 'rg "foo; pi -p" .';
    const launchCommand = 'pi --print "hi"';

    const events: ToolCallEvent[] = [
      {
        type: "tool_call",
        toolCallId: "bash-quoted",
        toolName: "bash",
        input: { command: quotedCommand },
      },
      {
        type: "tool_call",
        toolCallId: "bash-launch",
        toolName: "bash",
        input: { command: launchCommand },
      },
      {
        type: "tool_call",
        toolCallId: "bg-start-quoted",
        toolName: "bg_start",
        input: { command: quotedCommand },
      },
      {
        type: "tool_call",
        toolCallId: "bg-start-launch",
        toolName: "bg_start",
        input: { command: launchCommand },
      },
    ];

    const results = await Promise.all(
      events.map((event) => extension.emit("tool_call", event, context)),
    );

    assert.equal(results[0], undefined);
    assert.notEqual(results[1], undefined);
    assert.equal(results[2], undefined);
    assert.notEqual(results[3], undefined);
  } finally {
    process.argv = originalArgv;
  }
});

test("an owner's guard judges each launch by its own appends", () => {
  const ownerGuard = guardFor(ownerArgv);
  const delegateLaunch = `pi --print --append-system-prompt ${UNATTENDED} --append-system-prompt "${DELEGATE}"`;

  assert.equal(ownerGuard(`cd /tmp/app && ${delegateLaunch} "hi"`), undefined);
  assert.equal(ownerGuard(`${delegateLaunch} "a" & ${delegateLaunch} "b"`), undefined);
  assert.equal(ownerGuard(`${delegateLaunch} "hi" 2>&1 | tee log`), undefined);
  assert.equal(
    ownerGuard(`${delegateLaunch} <<'TASK'\nNever run pi --print yourself.\nTASK`),
    undefined,
    "a heredoc body is not a launch",
  );

  for (const command of [
    'pi --print "hi"',
    `pi --print --append-system-prompt ${DELEGATE} --append-system-prompt ${DELEGATE}; pi --print`,
    `${delegateLaunch} <<'TASK'\nhi\nTASK\npi -p "again"`,
    `${delegateLaunch} --append-system-prompt ${OWNER}`,
  ]) {
    assert.match(ownerGuard(command) ?? "", OWNER_BLOCK, command);
  }
});

test("a delegate is blocked from every pi-subagent launch", () => {
  const delegateGuard = guardFor(delegateArgv);

  for (const command of [
    "pi-subagent <<'EOF'\nhi\nEOF",
    "/home/u/.pi/.build/bin/pi-subagent --model anthropic/claude-opus-5-5",
    "cd /tmp/app && FOO=1 pi-subagent \\\n  --thinking high",
    `pi-subagent --append-system-prompt ${UNATTENDED} --append-system-prompt ${DELEGATE}`,
  ]) {
    assert.match(delegateGuard(command) ?? "", DELEGATE_BLOCK, command);
  }
});

for (const command of [
  "timeout 120 pi-subagent --model m",
  "nohup pi-subagent --model m",
  "env FOO=1 pi-subagent --model m",
  "exec pi-subagent --model m",
  "time pi-subagent --model m",
  "bash -c 'pi-subagent --model m'",
  "timeout -k 5 10m /home/u/.pi/.build/bin/pi-subagent --model m",
]) {
  test(`a delegate is blocked from a wrapped pi-subagent launch: ${command}`, () => {
    assert.match(guardFor(delegateArgv)(command) ?? "", DELEGATE_BLOCK);
  });
}

test("an owner's wrapped pi-subagent launch is judged by its appends", () => {
  const ownerGuard = guardFor(ownerArgv);

  assert.match(
    ownerGuard(`timeout 900 pi-subagent --append-system-prompt ${UNATTENDED} --model m`) ?? "",
    OWNER_BLOCK,
  );
  assert.equal(
    ownerGuard(
      `timeout 900 pi-subagent --append-system-prompt ${UNATTENDED} --append-system-prompt ${DELEGATE}`,
    ),
    undefined,
  );
});

test("an owner's pi-subagent launch without delegate.md is blocked", () => {
  const ownerGuard = guardFor(ownerArgv);

  for (const command of [
    "pi-subagent <<'EOF'\nhi\nEOF",
    `pi-subagent --append-system-prompt ${UNATTENDED} --append-system-prompt ${OWNER}`,
  ]) {
    assert.match(ownerGuard(command) ?? "", OWNER_BLOCK, command);
  }
});

test("an owner's pi-subagent launch with delegate.md is allowed", () => {
  const ownerGuard = guardFor(ownerArgv);

  assert.equal(
    ownerGuard(
      `pi-subagent --append-system-prompt ${UNATTENDED} --append-system-prompt "${DELEGATE}" <<'TASK'\nhi\nTASK`,
    ),
    undefined,
  );
});
