import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { spawnGuard } from "../delegate-guard.ts";
import { delegateArgv } from "./guard-fixtures.ts";

const LAUNCH = new URL("../../skills/subagents/scripts/launch.ts", import.meta.url).pathname;

const TREE_VARIABLES = [
  "PI_SUBAGENT_KIND",
  "PI_SUBAGENT_TREE_DEPTH",
  "PI_SUBAGENT_SESSION",
  "IMPLEMENT_CHUNK_STATE",
];

const DELEGATE_BLOCK = /^Delegates spawn nothing/;

const OWNER_BLOCK = /^Owners launch only delegates/;

const brief = (kind: string) => `GOAL         Deliver final PR A's tickets into chunk/demo/a.
KIND         ${kind}
SCOPE        the integration branch chunk/demo/a and the state folder
AUTHORITY    DECIDE AND REPORT: briefs. STOP ON: product calls.
CONTEXT      plan.md (user)
SKILLS       none: the brief names every step
ACCEPTANCE   every ticket merged with a passing verdict
VERIFY       chunk report
TIMEBOX      45 minutes
FORBIDDEN    merging to main
REPORT       todolist, then the diff
`;

interface Started {
  readonly argv: readonly string[];
  readonly kind: string | undefined;
}

function started(t: TestContext, kind: string, role: string): Started {
  const dir = mkdtempSync(join(tmpdir(), "guard-tree-"));
  t.after(() => execFileSync("rm", ["-rf", dir]));

  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "loadavg"), "0.10 0.20 0.30 1/100 12345\n");
  writeFileSync(join(dir, "meminfo"), "MemAvailable:   33554432 kB\n");
  writeFileSync(join(dir, "brief.md"), brief(kind));
  writeFileSync(
    join(bin, "pi-subagent"),
    `#!/bin/sh\nprintf '%s\\0' "$@" > '${dir}/argv'\nprintf '%s' "$PI_SUBAGENT_KIND" > '${dir}/kind'\ncat > /dev/null\n`,
  );
  chmodSync(join(bin, "pi-subagent"), 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    PI_LAUNCH_LOADAVG: join(dir, "loadavg"),
    PI_LAUNCH_MEMINFO: join(dir, "meminfo"),
  };

  for (const name of TREE_VARIABLES) delete env[name];

  const run = spawnSync(
    process.execPath,
    [
      LAUNCH,
      "--kind",
      kind,
      "--role",
      role,
      "--brief",
      join(dir, "brief.md"),
      "--orders",
      "none",
      "--model",
      "m",
      "--thinking",
      "high",
      "--name",
      role,
    ],
    { cwd: dir, env, encoding: "utf8" },
  );

  assert.equal(run.status, 0, run.stderr);

  return {
    argv: ["node", "pi", ...readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1)],
    kind: readFileSync(join(dir, "kind"), "utf8"),
  };
}

const ownerLaunch =
  "~/.pi/agent/skills/subagents/scripts/launch.ts --kind owner --role final-pr-owner --brief b.md";

const delegateLaunch =
  "~/.pi/agent/skills/subagents/scripts/launch.ts --kind delegate --role implementer --brief b.md";

test("a delegate the launcher starts is a delegate to the guard too", (t) => {
  const child = started(t, "delegate", "implementer");
  const guard = spawnGuard(child.argv);

  assert.equal(child.kind, "delegate");
  assert.ok(guard, "a delegate gets a guard");
  assert.match(guard(delegateLaunch) ?? "", DELEGATE_BLOCK);
  assert.match(guard(ownerLaunch) ?? "", DELEGATE_BLOCK);
});

test("an owner the launcher starts is an owner to the guard too", (t) => {
  const child = started(t, "owner", "final-pr-owner");
  const guard = spawnGuard(child.argv);

  assert.equal(child.kind, "owner");
  assert.ok(guard, "an owner gets a guard");
  assert.equal(guard(delegateLaunch), undefined, "an owner launches delegates");
  assert.match(guard(ownerLaunch) ?? "", OWNER_BLOCK);
});

// A real past run: the delegate "subagent: subagent launcher #102" (session
// 01a174ba-f44c-7439-bffe-a265f42ae339, entry 3309ac07, 2026-10-25) ran this bg_start command,
// and its child "subagent: launcher dogfood" started.
const PAST_DELEGATE_LAUNCH =
  'D=/home/drsh4dow/.local/state/pi-agent/pi-setup/implement-chunk-peers/evidence/launcher/dogfood; agent/skills/subagents/scripts/launch.ts --kind delegate --role assignment --brief $D/brief.md --orders $D/orders.md --model anthropic/claude-haiku-5-5 --thinking low --name "launcher dogfood" > $D/report.md 2> $D/launch.stderr; echo "exit $?" >> $D/launch.stderr';

test("the guard refuses the past run's launch from a delegate", () => {
  const guard = spawnGuard(delegateArgv);

  assert.ok(guard);
  assert.match(guard(PAST_DELEGATE_LAUNCH) ?? "", DELEGATE_BLOCK);
});
