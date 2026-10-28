import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

import delegateGuardExtension, { spawnGuard } from "../delegate-guard.ts";
import { extensionTestAdapter, unsafeFixture } from "./adapter.ts";
import {
  DELEGATE_PROMPT,
  OWNER_PROMPT,
  decodeDecision,
  delegateArgv,
  ownerArgv,
  rootArgv,
} from "./guard-fixtures.ts";

const skill = readFileSync(new URL("../../skills/subagents/SKILL.md", import.meta.url), "utf8");

const DELEGATE_BLOCK = /^Delegates spawn nothing/;

const OWNER_BLOCK = /^Owners launch only delegates/;

function guardFor(argv: readonly string[]): (command: string) => string | undefined {
  const guard = spawnGuard(argv);
  assert.ok(guard, `a subagent launched with ${argv.join(" ")} gets a guard`);

  return guard;
}

// The raw launch block's role prompt swapped for an owner's.
function asOwnerPrompt(text: string): string {
  return text.replace("generated/delegate/assignment.md", "generated/owner/babysitter.md");
}

function twoPrompts(first: string, last: string): string[] {
  return ["node", "pi", "--system-prompt", first, "--system-prompt", last];
}

test("the subagents skill's launch block starts a delegate, which an owner may run", () => {
  const launch = skill.match(/## Launch[\s\S]*?```bash\n([\s\S]*?)```/)?.[1];
  assert.ok(launch, "subagents SKILL.md has a bash launch block under ## Launch");

  const argv = launch
    .replaceAll("\\\n", " ")
    .replaceAll("$HOME", "/home/u")
    .split(/\s+/)
    .map((word) => word.replaceAll('"', ""));

  const asOwner = argv.map(asOwnerPrompt);

  const ownerLaunch = asOwnerPrompt(launch);

  assert.notEqual(ownerLaunch, launch, "the launch block passes the assignment role prompt");
  assert.match(guardFor(argv)(launch) ?? "", DELEGATE_BLOCK, "a delegate may not spawn");
  assert.equal(guardFor(asOwner)(launch), undefined, "an owner may launch a delegate");
  assert.match(
    guardFor(asOwner)(ownerLaunch) ?? "",
    OWNER_BLOCK,
    "an owner may not launch an owner",
  );
});

test("the subagents skill's brief launcher is blocked for a delegate, as pi-subagent is", () => {
  const block = skill.match(/## Launch from a brief[\s\S]*?```bash\n([\s\S]*?)```/)?.[1];
  assert.ok(block, "subagents SKILL.md has a bash block under ## Launch from a brief");

  const launch = block.replaceAll("$HOME", "/home/u");
  const asDelegate = launch.replace("<delegate|owner>", "delegate");
  const asOwner = launch.replace("<delegate|owner>", "owner");

  assert.match(guardFor(delegateArgv)(asDelegate) ?? "", DELEGATE_BLOCK);
  assert.match(guardFor(delegateArgv)(`${asDelegate} --dry-run`) ?? "", DELEGATE_BLOCK);
  assert.equal(guardFor(ownerArgv)(asDelegate), undefined, "an owner may launch a delegate");
  assert.match(guardFor(ownerArgv)(asOwner) ?? "", OWNER_BLOCK, "an owner may not launch an owner");
});

for (const command of [
  "/home/u/.pi/agent/skills/subagents/scripts/launch.ts --kind delegate --brief b.md",
  "node ~/.pi/agent/skills/subagents/scripts/launch.ts --kind=delegate --brief b.md",
  "cd /tmp/app && timeout 900 ~/.pi/agent/skills/subagents/scripts/launch.ts --kind owner",
]) {
  test(`a delegate is blocked from a launcher run: ${command}`, () => {
    assert.match(guardFor(delegateArgv)(command) ?? "", DELEGATE_BLOCK);
  });
}

test("an owner's launcher run is judged by its last --kind", () => {
  const ownerGuard = guardFor(ownerArgv);
  const launcher = "~/.pi/agent/skills/subagents/scripts/launch.ts";

  assert.equal(ownerGuard(`node ${launcher} --kind=delegate --brief b.md`), undefined);
  assert.match(ownerGuard(`${launcher} --brief b.md`) ?? "", OWNER_BLOCK, "no --kind");
  assert.match(ownerGuard(`${launcher} --kind delegate --kind owner`) ?? "", OWNER_BLOCK);
});

test("a process without a role prompt is a root and gets no guard", () => {
  for (const argv of [
    rootArgv,
    ["node", "pi", "--print", "--system-prompt", "/h/.pi/agent/SYSTEM.md"],
    ["node", "pi", "--system-prompt", "/h/.pi/agent/system/generated/sh4dow.md"],
    ["node", "pi", "--append-system-prompt", DELEGATE_PROMPT],
    ["node", "pi", "-p", "--system-prompt", `rules\nLaunch a delegate on ${DELEGATE_PROMPT}`],
  ]) {
    assert.equal(spawnGuard(argv), undefined, argv.join(" "));
  }
});

test("a process's kind is the directory of its last --system-prompt", () => {
  const delegateLast = twoPrompts(OWNER_PROMPT, DELEGATE_PROMPT);

  const ownerLast = twoPrompts(DELEGATE_PROMPT, OWNER_PROMPT);

  assert.match(guardFor(delegateLast)("pi-subagent --model m") ?? "", DELEGATE_BLOCK);
  assert.match(guardFor(ownerLast)("pi-subagent --model m") ?? "", OWNER_BLOCK);
  assert.equal(guardFor(ownerLast)(`pi-subagent --system-prompt ${DELEGATE_PROMPT}`), undefined);
});

test("Pi's options end at --, so a --system-prompt after it is a message and names no kind", () => {
  const delegateThenText = [...delegateArgv, "--", "--system-prompt", "plain.md"];

  assert.match(guardFor(delegateThenText)("pi-subagent --model m") ?? "", DELEGATE_BLOCK);
  assert.match(
    guardFor(ownerArgv)(
      `pi --print --system-prompt ${OWNER_PROMPT} -- --system-prompt ${DELEGATE_PROMPT}`,
    ) ?? "",
    OWNER_BLOCK,
    "the child runs on the owner prompt",
  );
  assert.equal(
    guardFor(ownerArgv)(
      `pi --print --system-prompt ${DELEGATE_PROMPT} -- --system-prompt ${OWNER_PROMPT}`,
    ),
    undefined,
    "the child runs on the delegate prompt",
  );
});

test("an option's value that spells --system-prompt is a value, not the flag", () => {
  assert.match(
    guardFor(ownerArgv)(`pi --print --append-system-prompt --system-prompt ${DELEGATE_PROMPT}`) ??
      "",
    OWNER_BLOCK,
    "Pi reads no --system-prompt there, so the child is a root",
  );
});

test("an appended delegate kind part makes a delegate, whatever the system prompt", () => {
  const kindPart = "/h/.pi/agent/system/kinds/delegate.md";

  const generalText = [
    "node",
    "pi",
    "-p",
    "--system-prompt",
    "You are a coding agent.\n<router>…</router>",
  ];

  for (const argv of [
    [...generalText, "--append-system-prompt", kindPart],
    [...ownerArgv, "--append-system-prompt", kindPart],
  ]) {
    assert.match(guardFor(argv)("pi-subagent --help") ?? "", DELEGATE_BLOCK, argv.join(" "));
  }

  assert.equal(
    guardFor(ownerArgv)(
      `pi-subagent --system-prompt 'general text' --append-system-prompt ${kindPart}`,
    ),
    undefined,
    "an owner may launch a child that runs as a delegate",
  );
  assert.equal(
    spawnGuard(["node", "pi", "--append-system-prompt", `The delegate part is\n${kindPart}`]),
    undefined,
    "a text that quotes the part's path names no kind",
  );
});

test("an owner's refusal names both ways to launch a delegate", () => {
  const reason = guardFor(ownerArgv)("pi-subagent --model m") ?? "";

  assert.ok(reason.includes("--kind delegate"), reason);
  assert.ok(reason.includes("system/generated/delegate/"), reason);
});

test("a subagent on a delegate role prompt spawns no pi print launch", () => {
  const delegateGuard = guardFor(delegateArgv);

  for (const command of [
    'pi -p "say ok"',
    'pi --print --no-session "say ok"',
    'cd /tmp/app && pi --model anthropic/claude-opus-5-5 --print "hi"',
    "/home/u/.bun/bin/pi --print <<'EOF'\nhi\nEOF",
    "FOO=1 pi \\\n  --thinking high \\\n  --print",
    `pi --print --system-prompt ${DELEGATE_PROMPT} "hi"`,
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
    "rg -n skills/subagents/scripts/launch.ts agent",
    "cat ~/.pi/agent/skills/subagents/scripts/launch.ts",
    "node --test agent/skills/subagents/scripts/test/launch.test.ts",
    "command -v pi-subagent",
    "type pi-subagent",
  ]) {
    assert.equal(delegateGuard(command), undefined, command);
    assert.equal(ownerGuard(command), undefined, command);
  }
});

test("a quoted launch string is a search pattern, not a launch", () => {
  const delegateGuard = guardFor(delegateArgv);
  const ownerGuard = guardFor(ownerArgv);

  for (const command of [
    'rg "foo; pi --print" .',
    "grep -n 'a; pi-subagent b' f",
    "grep -nE 'x|pi-subagent y' f",
    'grep -n "a && ~/.pi/agent/skills/subagents/scripts/launch.ts --kind owner" f',
  ]) {
    assert.equal(delegateGuard(command), undefined, command);
    assert.equal(ownerGuard(command), undefined, command);
  }
});

test("a launch inside a bash -c, sh -c, or eval string is judged like a direct one", () => {
  const delegateGuard = guardFor(delegateArgv);
  const ownerGuard = guardFor(ownerArgv);
  const delegateLaunch = `pi --print --system-prompt ${DELEGATE_PROMPT}`;

  for (const command of [
    "bash -c 'pi --print hi'",
    'sh -c "cd /tmp/app && pi -p hi"',
    "timeout 900 bash -lc 'pi-subagent --model m'",
    "eval 'pi --print hi'",
  ]) {
    assert.match(delegateGuard(command) ?? "", DELEGATE_BLOCK, command);
    assert.match(ownerGuard(command) ?? "", OWNER_BLOCK, command);
  }

  assert.match(delegateGuard(`bash -c '${delegateLaunch} hi'`) ?? "", DELEGATE_BLOCK);
  assert.equal(ownerGuard(`bash -c '${delegateLaunch} hi'`), undefined);
  assert.equal(delegateGuard("bash -c \"grep -n 'a; pi --print' f\""), undefined);
});

test("an owner's guard judges each launch by its own role prompt", () => {
  const ownerGuard = guardFor(ownerArgv);
  const delegateLaunch = `pi --print --system-prompt "${DELEGATE_PROMPT}"`;

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
    `pi --print --system-prompt ${DELEGATE_PROMPT} --system-prompt ${OWNER_PROMPT}; pi --print`,
    `${delegateLaunch} <<'TASK'\nhi\nTASK\npi -p "again"`,
    `${delegateLaunch} --system-prompt ${OWNER_PROMPT}`,
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
    `pi-subagent --system-prompt ${DELEGATE_PROMPT}`,
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
  "command pi --print hi",
  "command pi-subagent --model m",
  "builtin exec pi-subagent --model m",
  "sudo pi --print hi",
  "sudo -u x pi-subagent --model m",
  "doas -u x pi-subagent --model m",
  'env -S "pi-subagent --model m"',
  "env -u FOO pi-subagent --model m",
]) {
  test(`a delegate is blocked from a wrapped pi-subagent launch: ${command}`, () => {
    assert.match(guardFor(delegateArgv)(command) ?? "", DELEGATE_BLOCK);
  });
}

test("an owner's wrapped pi-subagent launch is judged by its role prompt", () => {
  const ownerGuard = guardFor(ownerArgv);

  assert.match(ownerGuard(`timeout 900 pi-subagent --model m`) ?? "", OWNER_BLOCK);
  assert.equal(ownerGuard(`timeout 900 pi-subagent --system-prompt ${DELEGATE_PROMPT}`), undefined);
});

test("an owner's pi-subagent launch without a delegate role prompt is blocked", () => {
  const ownerGuard = guardFor(ownerArgv);

  for (const command of [
    "pi-subagent <<'EOF'\nhi\nEOF",
    `pi-subagent --system-prompt ${OWNER_PROMPT}`,
  ]) {
    assert.match(ownerGuard(command) ?? "", OWNER_BLOCK, command);
  }
});

test("an owner's pi-subagent launch on a delegate role prompt is allowed", () => {
  const ownerGuard = guardFor(ownerArgv);

  assert.equal(
    ownerGuard(`pi-subagent --system-prompt "${DELEGATE_PROMPT}" <<'TASK'\nhi\nTASK`),
    undefined,
  );
});

test("a launch inside a command substitution is judged like a direct one", () => {
  const delegateGuard = guardFor(delegateArgv);
  const ownerGuard = guardFor(ownerArgv);

  for (const command of [
    'echo "$(true; pi --print hi)"',
    'echo "$(true; pi-subagent --model m)"',
    "out=$(pi --print hi)",
    "echo `pi -p hi`",
    'echo "`pi-subagent --model m`"',
    "cat <<EOF\n$(pi --print hi)\nEOF",
  ]) {
    assert.match(delegateGuard(command) ?? "", DELEGATE_BLOCK, command);
    assert.match(ownerGuard(command) ?? "", OWNER_BLOCK, command);
  }

  for (const command of [
    "grep -n '$(pi --print hi)' notes.md",
    "echo '`pi-subagent --model m`'",
    "cat <<'EOF'\n$(pi --print hi)\nEOF",
  ]) {
    assert.equal(delegateGuard(command), undefined, command);
    assert.equal(ownerGuard(command), undefined, command);
  }
});

test("a launch inside a subshell, a brace group, or a compound command is judged like a direct one", () => {
  const delegateGuard = guardFor(delegateArgv);
  const ownerGuard = guardFor(ownerArgv);

  for (const command of [
    "(pi --print hi)",
    "{ pi-subagent --model m; }",
    "if true; then pi --print hi; fi",
    "while true; do pi-subagent --model m; done",
  ]) {
    assert.match(delegateGuard(command) ?? "", DELEGATE_BLOCK, command);
    assert.match(ownerGuard(command) ?? "", OWNER_BLOCK, command);
  }
});

test("a delegate session's bash and bg_start calls are refused a launch, and other tools are not judged", async () => {
  const launchArgv = process.argv;
  process.argv = [...delegateArgv];
  const adapter = extensionTestAdapter();

  try {
    delegateGuardExtension(adapter.api);
  } finally {
    process.argv = launchArgv;
  }

  const call = async (toolName: string, input: Record<string, string>) =>
    decodeDecision(
      await adapter.emit(
        "tool_call",
        unsafeFixture<ToolCallEvent>({ type: "tool_call", toolCallId: "call-1", toolName, input }),
        unsafeFixture<ExtensionContext>({}),
      ),
    );

  const [bashLaunch, bgStartLaunch, bashVerify, bgStartVerify, write] = await Promise.all([
    call("bash", { command: "pi --print hi" }),
    call("bg_start", { command: "pi --print hi" }),
    call("bash", { command: "vp run verify" }),
    call("bg_start", { command: "vp run verify" }),
    call("write", { path: "notes.md", content: "pi --print hi" }),
  ]);

  assert.match(bashLaunch?.reason ?? "", DELEGATE_BLOCK);
  assert.match(bgStartLaunch?.reason ?? "", DELEGATE_BLOCK);
  assert.equal(bashVerify, undefined);
  assert.equal(bgStartVerify, undefined);
  assert.equal(write, undefined);
});

test("a launch string handed to a program that runs it is judged like a direct one", () => {
  const delegateGuard = guardFor(delegateArgv);
  const ownerGuard = guardFor(ownerArgv);

  for (const command of [
    'tmux new-session -d "pi --print hi"',
    'ssh host "cd /repo && pi-subagent --model m"',
    'watch "pi -p hi"',
    'script -c "pi --print hi"',
    'echo "pi --print hi" | bash',
  ]) {
    assert.match(delegateGuard(command) ?? "", DELEGATE_BLOCK, command);
    assert.match(ownerGuard(command) ?? "", OWNER_BLOCK, command);
  }

  assert.equal(
    ownerGuard(`tmux new-session -d "pi --print --system-prompt ${DELEGATE_PROMPT} hi"`),
    undefined,
  );
  assert.equal(
    ownerGuard(`pi --print --system-prompt ${DELEGATE_PROMPT} "never run pi --print"`),
    undefined,
  );

  for (const command of ['echo "pi --print hi"', 'printf "%s\\n" "a; pi-subagent b"']) {
    assert.equal(delegateGuard(command), undefined, command);
    assert.equal(ownerGuard(command), undefined, command);
  }
});
