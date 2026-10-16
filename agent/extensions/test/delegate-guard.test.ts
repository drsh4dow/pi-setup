import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { isDelegateLaunch, spawnsPiPrint } from "../delegate-guard.ts";

const skill = readFileSync(new URL("../../skills/subagents/SKILL.md", import.meta.url), "utf8");

test("the subagents skill's launch block starts a delegate and is a blocked spawn", () => {
  const launch = skill.match(/## Launch[\s\S]*?```bash\n([\s\S]*?)```/)?.[1];
  assert.ok(launch, "subagents SKILL.md has a bash launch block under ## Launch");
  assert.ok(spawnsPiPrint(launch));

  const argv = launch
    .replaceAll("\\\n", " ")
    .replaceAll("$HOME", "/home/u")
    .split(/\s+/)
    .map((word) => word.replaceAll('"', ""));

  assert.ok(isDelegateLaunch(argv), "the launch appends the prompt the guard recognizes");
});

test("pi print-mode spawns are recognized in common shapes", () => {
  for (const command of [
    'pi -p "say ok"',
    'pi --print --no-session "say ok"',
    'cd /tmp/app && pi --model anthropic/claude-opus-5-5 --print "hi"',
    "/home/u/.bun/bin/pi --print <<'EOF'\nhi\nEOF",
    "FOO=1 pi \\\n  --thinking high \\\n  --print",
  ]) {
    assert.ok(spawnsPiPrint(command), command);
  }
});

test("other commands pass", () => {
  for (const command of [
    "vp run verify",
    "mkdir -p pi",
    "pip install -p x",
    "git log -p",
    "ls ~/.pi/agent -p",
    "pi --help",
    "api --print",
  ]) {
    assert.equal(spawnsPiPrint(command), false, command);
  }
});

test("only a launch that appends delegate.md is a delegate", () => {
  const owner = [
    "node",
    "pi",
    "--print",
    "--append-system-prompt",
    "/h/.pi/agent/skills/subagents/unattended.md",
  ];

  assert.equal(isDelegateLaunch(owner), false);
  assert.ok(
    isDelegateLaunch([
      ...owner,
      "--append-system-prompt",
      "/h/.pi/agent/skills/subagents/delegate.md",
    ]),
  );
});
