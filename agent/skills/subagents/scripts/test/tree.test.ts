import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";


const LAUNCH = new URL("../launch.ts", import.meta.url).pathname;

const AGENT_DIR = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");

// Variables a launch reads from its own environment. The test process may itself run inside a
// subagent, so every host starts without them.
const TREE_VARIABLES = [
  "PI_SUBAGENT_KIND",
  "PI_SUBAGENT_TREE_DEPTH",
  "PI_SUBAGENT_SESSION",
  "IMPLEMENT_CHUNK_STATE",
];

const BRIEF = (kind: string) => `GOAL         Deliver final PR A's tickets into chunk/demo/a.
KIND         ${kind}
SCOPE        the integration branch chunk/demo/a and the state folder
AUTHORITY    DECIDE AND REPORT: briefs. STOP ON: product calls.
CONTEXT      plan.md (user)
SKILLS       none: the brief names every step
ACCEPTANCE   every ticket of final PR A merged into chunk/demo/a with a passing verdict
VERIFY       chunk report
TIMEBOX      45 minutes
FORBIDDEN    merging to main
REPORT       todolist, then the diff
`;

interface Host {
  readonly dir: string;
  readonly state: string;
  readonly orders: string;
  readonly env: NodeJS.ProcessEnv;
  brief(name: string, text: string): string;
  seen(): Seen[];
}

interface Seen {
  readonly session: string;
  readonly env: Readonly<Record<string, string>>;
  readonly registry: string;
  readonly nested: number | null;
}

function host(t: TestContext): Host {
  const dir = mkdtempSync(join(tmpdir(), "tree-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const state = join(dir, "state");
  mkdirSync(state);

  const orders = join(dir, "orders.md");
  writeFileSync(orders, "1. Base branch is main. (user)\n");

  const loadavg = join(dir, "loadavg");
  writeFileSync(loadavg, "0.10 0.20 0.30 1/100 12345\n");

  const meminfo = join(dir, "meminfo");
  writeFileSync(meminfo, "MemTotal:       65536000 kB\nMemAvailable:   33554432 kB\n");

  const bin = join(dir, "bin");
  mkdirSync(bin);

  const seenDir = join(dir, "seen");
  mkdirSync(seenDir);

  const fake = join(bin, "pi-subagent");
  writeFileSync(
    fake,
    `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const session = args[args.indexOf(args.includes("--session-id") ? "--session-id" : "--session") + 1];
const env = Object.fromEntries(${JSON.stringify(TREE_VARIABLES)}.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
const registryPath = process.env.IMPLEMENT_CHUNK_STATE ? process.env.IMPLEMENT_CHUNK_STATE + "/spawns.tsv" : "";
const registry = registryPath && existsSync(registryPath) ? readFileSync(registryPath, "utf8") : "";
readFileSync(0);
let nested = null;
const brief = process.env.FAKE_NESTED_BRIEF;
if (brief) {
  const run = spawnSync(process.execPath, [${JSON.stringify(LAUNCH)}, "--kind", "delegate", "--role", "implementer", "--brief", brief, "--orders", ${JSON.stringify(orders)}, "--model", "m", "--thinking", "high", "--name", "nested " + process.env.PI_SUBAGENT_KIND], { encoding: "utf8" });
  nested = run.status;
  appendFileSync(${JSON.stringify(join(seenDir, "nested.log"))}, run.stderr);
}
appendFileSync(${JSON.stringify(join(seenDir, "seen.jsonl"))}, JSON.stringify({ session, env, registry, nested }) + "\\n");
console.log("fake report");
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`,
  );
  chmodSync(fake, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    PI_LAUNCH_LOADAVG: loadavg,
    PI_LAUNCH_MEMINFO: meminfo,
  };

  for (const name of TREE_VARIABLES) delete env[name];

  return {
    dir,
    state,
    orders,
    env,
    brief(name, text) {
      const path = join(dir, name);
      writeFileSync(path, text);

      return path;
    },
    seen() {
      const path = join(seenDir, "seen.jsonl");

      if (!existsSync(path)) return [];

      return readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Seen);
    },
  };
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function args(h: Host, kind: string, role: string, brief: string): string[] {
  return [
    "--kind",
    kind,
    "--role",
    role,
    "--brief",
    brief,
    "--orders",
    h.orders,
    "--model",
    "anthropic/claude-opus-5-5",
    "--thinking",
    "high",
    "--name",
    `${role} A`,
  ];
}

function launch(h: Host, words: readonly string[], env: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync(process.execPath, [LAUNCH, ...words], {
    cwd: h.dir,
    env: { ...h.env, ...env },
    encoding: "utf8",
  });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function ownerLaunch(h: Host, extra: readonly string[] = [], env: NodeJS.ProcessEnv = {}): Run {
  return launch(h, [...args(h, "owner", "final-pr-owner", h.brief("owner.md", BRIEF("owner"))), ...extra], env);
}

function delegateLaunch(h: Host, extra: readonly string[] = [], env: NodeJS.ProcessEnv = {}): Run {
  return launch(h, [...args(h, "delegate", "implementer", h.brief("delegate.md", BRIEF("delegate"))), ...extra], env);
}

function parentAt(kind: string, depth: number, session = "11111111-2222-4333-8444-555555555555"): NodeJS.ProcessEnv {
  return { PI_SUBAGENT_KIND: kind, PI_SUBAGENT_TREE_DEPTH: String(depth), PI_SUBAGENT_SESSION: session };
}

function sessionOf(run: Run): string {
  const session = /^launch: session (\S+)$/m.exec(run.stderr)?.[1];
  assert.ok(session, run.stderr);

  return session;
}

function registry(h: Host): Record<string, string>[] {
  const path = join(h.state, "spawns.tsv");

  if (!existsSync(path)) return [];

  const [header = "", ...rows] = readFileSync(path, "utf8").trimEnd().split("\n");
  const columns = header.split("\t");

  return rows.map((row) => Object.fromEntries(row.split("\t").map((cell, index) => [columns[index], cell])));
}

function assertRefused(h: Host, run: Run, line: string): void {
  assert.equal(run.status, 2, run.stderr);
  assert.ok(run.stderr.split("\n").includes(line), run.stderr);
  assert.deepEqual(h.seen(), [], "no Pi process started");
}

test("a dry run of the final-PR owner prints its role prompt", (t) => {
  const h = host(t);
  const run = ownerLaunch(h, ["--dry-run"]);
  const prompt = `${AGENT_DIR}/system/generated/owner/final-pr-owner.md`;

  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes(`--- system prompt: ${prompt} ---\n${readFileSync(prompt, "utf8").trimEnd()}\n`), run.stdout);
  assert.match(readFileSync(prompt, "utf8"), /final-PR owner/);
});

test("a delegate launches nothing, dry run or not", (t) => {
  const h = host(t);

  for (const extra of [["--dry-run"], []]) {
    assertRefused(h, delegateLaunch(h, extra, parentAt("delegate", 1)), "launch: refused: a delegate launches nothing");
  }
});

test("an owner launched by an owner is refused, and an owner's delegate is not", (t) => {
  const h = host(t);

  assertRefused(
    h,
    ownerLaunch(h, ["--dry-run"], parentAt("owner", 1)),
    "launch: refused: an owner launches only delegates (--kind delegate)",
  );

  const delegate = delegateLaunch(h, ["--dry-run"], parentAt("owner", 1));

  assert.equal(delegate.status, 0, delegate.stderr);
});

test("a launch past depth two is refused", (t) => {
  const h = host(t);

  assertRefused(h, delegateLaunch(h, ["--dry-run"], parentAt("owner", 2)), "launch: refused: depth 3 is past the limit of 2");
  assertRefused(h, delegateLaunch(h, ["--dry-run"], parentAt("owner", 4)), "launch: refused: depth 5 is past the limit of 2");
});

test("a launch whose tree position it cannot read is refused", (t) => {
  const h = host(t);
  const cases: NodeJS.ProcessEnv[] = [
    { ...parentAt("owner", 1), PI_SUBAGENT_KIND: "worker" },
    { ...parentAt("owner", 1), PI_SUBAGENT_TREE_DEPTH: "" },
    { ...parentAt("owner", 1), PI_SUBAGENT_TREE_DEPTH: "one" },
    { ...parentAt("owner", 1), PI_SUBAGENT_SESSION: "" },
    { PI_SUBAGENT_TREE_DEPTH: "1" },
  ];

  for (const env of cases) {
    const run = delegateLaunch(h, ["--dry-run"], env);

    assert.equal(run.status, 2, JSON.stringify(env));
    assert.match(run.stderr, /^launch: refused: .*PI_SUBAGENT_/m, JSON.stringify(env));
  }

  assert.deepEqual(h.seen(), []);
});

test("a child carries its kind, its depth, and its own session id", (t) => {
  const h = host(t);
  const owner = ownerLaunch(h);
  const delegate = delegateLaunch(h, [], parentAt("owner", 1));

  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(delegate.status, 0, delegate.stderr);
  assert.deepEqual(
    h.seen().map(({ session, env }) => ({ session, env })),
    [
      {
        session: sessionOf(owner),
        env: { PI_SUBAGENT_KIND: "owner", PI_SUBAGENT_TREE_DEPTH: "1", PI_SUBAGENT_SESSION: sessionOf(owner) },
      },
      {
        session: sessionOf(delegate),
        env: { PI_SUBAGENT_KIND: "delegate", PI_SUBAGENT_TREE_DEPTH: "2", PI_SUBAGENT_SESSION: sessionOf(delegate) },
      },
    ],
    "no state folder, so no IMPLEMENT_CHUNK_STATE",
  );
});

test("a launch with a state folder registers the child before Pi starts and its end after", (t) => {
  const h = host(t);
  const reported = ownerLaunch(h, ["--state", h.state, "--unit", "final-a"]);
  const failed = delegateLaunch(h, ["--state", h.state], { FAKE_EXIT: "1" });

  assert.equal(reported.status, 0, reported.stderr);
  assert.equal(failed.status, 1, failed.stderr);

  const [ownerSeen, delegateSeen] = h.seen();

  assert.equal(ownerSeen?.env.IMPLEMENT_CHUNK_STATE, h.state, "the child inherits the state folder");
  assert.match(ownerSeen?.registry ?? "", new RegExp(`^${sessionOf(reported)}\troot\towner\tfinal-pr-owner\t1\tfinal-a\tsubagent: final-pr-owner A\trunning\t`, "m"));
  assert.match(delegateSeen?.registry ?? "", new RegExp(`^${sessionOf(failed)}\troot\tdelegate\timplementer\t1\t-\t.*\trunning\t`, "m"));

  const rows = registry(h).map(({ session, state }) => [session, state]);

  assert.deepEqual(rows, [
    [sessionOf(reported), "running"],
    [sessionOf(reported), "reported"],
    [sessionOf(failed), "running"],
    [sessionOf(failed), "failed"],
  ]);
});

test("IMPLEMENT_CHUNK_STATE names the state folder when --state is absent", (t) => {
  const h = host(t);
  const run = delegateLaunch(h, [], { IMPLEMENT_CHUNK_STATE: h.state });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(registry(h).map(({ state }) => state), ["running", "reported"]);
});

test("an owner's delegates are registered under the owner, and a delegate's launch is refused", (t) => {
  const h = host(t);
  const nested = h.brief("nested.md", BRIEF("delegate"));
  const run = ownerLaunch(h, ["--state", h.state], { FAKE_NESTED_BRIEF: nested });

  assert.equal(run.status, 0, run.stderr);

  const owner = sessionOf(run);
  const [delegateSeen, ownerSeen] = h.seen();

  assert.equal(ownerSeen?.nested, 0, "the owner's delegate reported");
  assert.equal(delegateSeen?.nested, 2, "the delegate's own launch was refused");
  assert.match(readFileSync(join(h.dir, "seen", "nested.log"), "utf8"), /^launch: refused: a delegate launches nothing$/m);
  assert.deepEqual(
    registry(h).map(({ session, parent, kind, role, depth, state }) => [session, parent, kind, role, depth, state]),
    [
      [owner, "root", "owner", "final-pr-owner", "1", "running"],
      [delegateSeen?.session, owner, "delegate", "implementer", "2", "running"],
      [delegateSeen?.session, owner, "delegate", "implementer", "2", "reported"],
      [owner, "root", "owner", "final-pr-owner", "1", "reported"],
    ],
  );
});

test("a resumed child's row runs again and ends again", (t) => {
  const h = host(t);
  const first = delegateLaunch(h, ["--state", h.state]);
  const directive = h.brief("resume.md", "Also cover the timeout path.\n");
  const resumed = launch(h, [
    ...args(h, "delegate", "implementer", directive),
    "--resume",
    sessionOf(first),
    "--state",
    h.state,
  ]);

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(registry(h).map(({ state }) => state), ["running", "reported", "running", "reported"]);
  assert.match(h.seen()[1]?.registry ?? "", /\trunning\t[^\n]*\n$/, "the resume's running row precedes Pi");
});

test("a resumed child is registered under the parent that resumed it, at that parent's depth", (t) => {
  const h = host(t);
  const first = delegateLaunch(h, ["--state", h.state, "--unit", "final-a"], parentAt("owner", 1, "owner-a"));

  assert.equal(first.status, 0, first.stderr);

  const child = sessionOf(first);
  const directive = h.brief("resume.md", "Continue the same work.\n");
  const resume = (env: NodeJS.ProcessEnv) =>
    launch(h, [...args(h, "delegate", "implementer", directive), "--resume", child, "--state", h.state], env);

  // The original owner, another owner, then the coordinator after both owners ended.
  for (const env of [parentAt("owner", 1, "owner-a"), parentAt("owner", 1, "owner-b"), {}]) {
    const run = resume(env);

    assert.equal(run.status, 0, run.stderr);
  }

  const rows = registry(h).map(({ session, parent, kind, role, depth, unit, name, state }) => [
    session,
    parent,
    kind,
    role,
    depth,
    unit,
    name,
    state,
  ]);
  const named = ["final-a", "subagent: implementer A"];

  assert.deepEqual(rows, [
    [child, "owner-a", "delegate", "implementer", "2", ...named, "running"],
    [child, "owner-a", "delegate", "implementer", "2", ...named, "reported"],
    [child, "owner-a", "delegate", "implementer", "2", ...named, "running"],
    [child, "owner-a", "delegate", "implementer", "2", ...named, "reported"],
    [child, "owner-b", "delegate", "implementer", "2", ...named, "running"],
    [child, "owner-b", "delegate", "implementer", "2", ...named, "reported"],
    [child, "root", "delegate", "implementer", "1", ...named, "running"],
    [child, "root", "delegate", "implementer", "1", ...named, "reported"],
  ]);
  assert.deepEqual(
    h.seen().map(({ env }) => env.PI_SUBAGENT_TREE_DEPTH),
    ["2", "2", "2", "1"],
    "each child runs at the depth its row records",
  );
});

test("a resume refuses what a launch refuses and writes no row", (t) => {
  const h = host(t);
  const first = delegateLaunch(h, ["--state", h.state], parentAt("owner", 1, "owner-a"));

  assert.equal(first.status, 0, first.stderr);

  const before = readFileSync(join(h.state, "spawns.tsv"), "utf8");
  const directive = h.brief("resume.md", "Continue the same work.\n");
  const resume = (env: NodeJS.ProcessEnv) =>
    launch(h, [...args(h, "delegate", "implementer", directive), "--resume", sessionOf(first), "--state", h.state], env);

  for (const [env, line] of [
    [parentAt("delegate", 2), "launch: refused: a delegate launches nothing"],
    [parentAt("owner", 2), "launch: refused: depth 3 is past the limit of 2"],
  ] as const) {
    const run = resume(env);

    assert.equal(run.status, 2, run.stderr);
    assert.ok(run.stderr.split("\n").includes(line), run.stderr);
  }

  assert.equal(readFileSync(join(h.state, "spawns.tsv"), "utf8"), before);
  assert.equal(h.seen().length, 1, "only the first launch started Pi");
});

test("a resume under another role, kind, or unit than its row records is refused and writes no row", (t) => {
  const h = host(t);
  const first = delegateLaunch(h, ["--state", h.state, "--unit", "old-unit"]);

  assert.equal(first.status, 0, first.stderr);

  const before = readFileSync(join(h.state, "spawns.tsv"), "utf8");
  const directive = h.brief("resume.md", "Continue the same work.\n");
  const resume = (kind: string, role: string, extra: readonly string[] = []) =>
    launch(h, [...args(h, kind, role, directive), "--resume", sessionOf(first), "--state", h.state, ...extra]);

  for (const run of [
    resume("delegate", "verifier"),
    resume("owner", "final-pr-owner"),
    resume("delegate", "implementer", ["--unit", "new-unit"]),
  ]) {
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /^launch: refused: could not register the spawn in .*: .* recorded /m);
  }

  assert.equal(readFileSync(join(h.state, "spawns.tsv"), "utf8"), before);
  assert.equal(h.seen().length, 1, "only the first launch started Pi");

  const same = resume("delegate", "implementer", ["--unit", "old-unit"]);

  assert.equal(same.status, 0, same.stderr);
  assert.equal(resume("delegate", "implementer").status, 0, "a resume without --unit keeps the unit");
});

test("a dry run and a refused launch write no registry row", (t) => {
  const h = host(t);

  assert.equal(ownerLaunch(h, ["--state", h.state, "--dry-run"]).status, 0);
  assert.equal(ownerLaunch(h, ["--state", h.state], parentAt("owner", 1)).status, 2);
  assert.deepEqual(registry(h), []);
});

test("a state folder that does not exist is refused before Pi starts", (t) => {
  const h = host(t);

  assertRefused(h, delegateLaunch(h, ["--state", join(h.dir, "missing")]), `launch: refused: state folder ${join(h.dir, "missing")} does not exist`);
});

// A real past run: the delegate "subagent: subagent launcher #102" (session
// 01a174ba-f44c-7439-bffe-a265f42ae339, entry 3309ac07, 2026-10-25) started this launch from its
// own bg_start, and the child "subagent: launcher dogfood" ran. Its brief and orders were state
// files of that run; synthetic ones stand in for them here.
const PAST_DELEGATE_LAUNCH =
  'D=/home/drsh4dow/.local/state/pi-agent/pi-setup/implement-chunk-peers/evidence/launcher/dogfood; agent/skills/subagents/scripts/launch.ts --kind delegate --role assignment --brief $D/brief.md --orders $D/orders.md --model anthropic/claude-haiku-5-5 --thinking low --name "launcher dogfood" > $D/report.md 2> $D/launch.stderr; echo "exit $?" >> $D/launch.stderr';

test("the past run's launch from a delegate is refused", (t) => {
  const h = host(t);
  const recorded = /launch\.ts (.*?) >/.exec(PAST_DELEGATE_LAUNCH)?.[1];
  assert.ok(recorded);

  writeFileSync(join(h.dir, "brief.md"), "Reply with the first line of your standing orders.\n");
  writeFileSync(join(h.dir, "orders.md"), "1. Reply in one line. (user)\n");

  const words = (recorded.match(/"[^"]*"|\S+/g) ?? []).map((word) => word.replaceAll('"', "").replace("$D", h.dir));
  const run = launch(h, words, parentAt("delegate", 1, "01a174ba-f44c-7439-bffe-a265f42ae339"));

  assertRefused(h, run, "launch: refused: a delegate launches nothing");
});
