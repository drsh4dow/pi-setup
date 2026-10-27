import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const LAUNCH = new URL("../launch.ts", import.meta.url).pathname;

const CODE_REVIEW_SKILL = new URL("../../../code-review/SKILL.md", import.meta.url).pathname;

const SUBAGENTS_SKILL = new URL("../../SKILL.md", import.meta.url).pathname;

const IMPLEMENTER_BRIEF = `GOAL         Add a retry to the upload client so a dropped connection resumes.
KIND         delegate
SCOPE        writes src/upload/**; worktree .worktrees/unit-1 on branch unit-1
AUTHORITY    DECIDE AND REPORT: tests that pin the changed code. STOP ON: any other write.
CONTEXT      ticket 12 (user), notes/contract.md (verified at abc123)
SKILLS       tdd
ACCEPTANCE   a dropped connection resumes: npm test -- upload
             the Definition of Done
VERIFY       npm test -- upload
TIMEBOX      45 minutes
FORBIDDEN    no rebase: the integration branch is shared; merge instead
REPORT       status, branch, head SHA, PR, what ran
`;

interface Host {
  readonly dir: string;
  readonly orders: string;
  readonly marker: string;
  readonly env: NodeJS.ProcessEnv;
  brief(name: string, text: string): string;
}

// A scratch state folder with an orders file, an idle injected host, and a fake pi-subagent on
// PATH that records its argv and stdin, so a test can tell whether a Pi process started.
function host(t: TestContext): Host {
  const dir = mkdtempSync(join(tmpdir(), "launch-test-"));
  t.after(() => execFileSync("rm", ["-rf", dir]));

  const orders = join(dir, "orders.md");
  writeFileSync(orders, "1. Base branch is main. (user)\n2. No production access. (user)\n");

  const loadavg = join(dir, "loadavg");
  writeFileSync(loadavg, "0.10 0.20 0.30 1/100 12345\n");

  const meminfo = join(dir, "meminfo");
  writeFileSync(meminfo, "MemTotal:       65536000 kB\nMemAvailable:   33554432 kB\n");

  const bin = join(dir, "bin");
  mkdirSync(bin);

  const marker = join(dir, "pi-subagent-ran");
  const fake = join(bin, "pi-subagent");
  writeFileSync(
    fake,
    `#!/bin/sh\nprintf '%s\\0' "$@" > '${marker}.argv'\ncat > '${marker}.stdin'\ntouch '${marker}'\necho 'fake report'\n`,
  );
  chmodSync(fake, 0o755);

  return {
    dir,
    orders,
    marker,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PI_LAUNCH_LOADAVG: loadavg,
      PI_LAUNCH_MEMINFO: meminfo,
    },
    brief(name, text) {
      const path = join(dir, name);
      writeFileSync(path, text);

      return path;
    },
  };
}

function replaceAtomically(path: string, text: string): void {
  writeFileSync(`${path}.next`, text);
  renameSync(`${path}.next`, path);
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function baseArgs(h: Host, brief: string, role = "implementer"): string[] {
  return [
    "--kind",
    "delegate",
    "--role",
    role,
    "--brief",
    brief,
    "--orders",
    h.orders,
    "--model",
    "anthropic/claude-opus-5-5",
    "--thinking",
    "medium",
    "--name",
    "unit-1",
  ];
}

function launch(h: Host, args: readonly string[], cwd = h.dir): Run {
  const result = spawnSync(process.execPath, [LAUNCH, ...args], { cwd, env: h.env, encoding: "utf8" });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function dryRun(h: Host, brief: string, role = "implementer", cwd = h.dir): Run {
  return launch(h, [...baseArgs(h, brief, role), "--dry-run"], cwd);
}

function assertRefused(h: Host, run: Run, reason: RegExp): void {
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, reason);
  assert.equal(existsSync(h.marker), false, "no Pi process started");
}

test("a child launched after an order is appended carries that order", (t) => {
  const h = host(t);
  const brief = h.brief("brief.md", IMPLEMENTER_BRIEF);

  appendFileSync(h.orders, "3. Never kill a process by pattern. (user)\n");

  const run = dryRun(h, brief);

  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes("3. Never kill a process by pattern. (user)"), run.stdout);
  assert.match(run.stdout, /standing orders, 3 lines/);
  assert.ok(run.stdout.includes(`--append-system-prompt ${h.orders}`), run.stdout);
  assert.ok(run.stdout.includes(IMPLEMENTER_BRIEF.trimEnd()), "the brief is the prompt");
});

test("a resumed child carries the current orders too", (t) => {
  const h = host(t);
  const brief = h.brief("brief.md", IMPLEMENTER_BRIEF);
  const first = dryRun(h, brief);
  const session = /^session: (\S+) \(new\)$/m.exec(first.stdout)?.[1];
  assert.ok(session, first.stdout);

  appendFileSync(h.orders, "3. Run the integration suite in CI only. (user)\n");

  const directive = h.brief("resume.md", "Also cover the timeout path the verifier named.\n");
  const run = launch(h, [...baseArgs(h, directive), "--resume", session, "--dry-run"]);

  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes("3. Run the integration suite in CI only. (user)"), run.stdout);
  assert.ok(run.stdout.includes(`--session ${session}`), run.stdout);
  assert.match(run.stdout, /--- prompt \(stdin\) ---\nYour system prompt was rebuilt for this resume\. .*\n\nAlso cover the timeout path/);
  assert.ok(!first.stdout.includes("integration suite"), "the first launch predates the order");
});

test("a launch passes the brief on stdin and the appends on the command line", (t) => {
  const h = host(t);
  const brief = h.brief("brief.md", IMPLEMENTER_BRIEF);
  const run = launch(h, baseArgs(h, brief));

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "fake report\n", "stdout holds only the child's report");
  assert.equal(readFileSync(`${h.marker}.stdin`, "utf8"), IMPLEMENTER_BRIEF);

  const argv = readFileSync(`${h.marker}.argv`, "utf8").split("\0");
  const appends = argv.flatMap((word, index) => (word === "--append-system-prompt" ? [argv[index + 1] ?? ""] : []));
  const [unattended, kind, heading, orders, ...rest] = appends;

  assert.match(unattended ?? "", /\/skills\/subagents\/unattended\.md$/);
  assert.match(kind ?? "", /\/skills\/subagents\/delegate\.md$/);
  assert.match(heading ?? "", /^# Standing orders\n/, "a literal heading labels the orders");
  assert.ok(heading?.includes(h.orders), "the heading names the orders file");
  assert.equal(orders, h.orders, "the orders travel as a path Pi reads at start");
  assert.deepEqual(rest, []);
  assert.equal(argv[argv.indexOf("--name") + 1], "subagent: unit-1");
});

test("a missing or empty brief is refused", (t) => {
  const h = host(t);

  assertRefused(h, launch(h, baseArgs(h, join(h.dir, "missing.md"))), /brief .*missing\.md does not exist/);
  assertRefused(h, launch(h, baseArgs(h, h.brief("empty.md", "\n  \n"))), /brief .*empty\.md is empty/);
});

test("a missing or empty orders file is refused, since Pi would append the path as text", (t) => {
  const h = host(t);
  const brief = h.brief("brief.md", IMPLEMENTER_BRIEF);
  const args = baseArgs(h, brief);

  args[args.indexOf("--orders") + 1] = join(h.dir, "nope.md");
  assertRefused(h, launch(h, args), /orders file .*nope\.md does not exist/);

  args[args.indexOf("--orders") + 1] = h.brief("blank-orders.md", "");
  assertRefused(h, launch(h, args), /orders file .*blank-orders\.md is empty/);

  args[args.indexOf("--orders") + 1] = "none";
  const run = launch(h, [...args, "--dry-run"]);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!run.stdout.includes("standing orders"), run.stdout);
});

test("a brief missing a required field is refused and the field named", (t) => {
  const h = host(t);
  const noVerify = h.brief("no-verify.md", IMPLEMENTER_BRIEF.replace(/^VERIFY .*\n/m, ""));

  assertRefused(h, dryRun(h, noVerify), /missing required field VERIFY/);
});

test("a collapsed brief needs only GOAL, SCOPE, VERIFY, and REPORT named", (t) => {
  const h = host(t);
  const collapsed =
    "COLLAPSED one-command unit. GOAL: bump the lockfile. SCOPE: bun.lock on branch unit-2. " +
    "VERIFY: bun install --frozen-lockfile. REPORT: the command's output and the head SHA.\n";

  const run = dryRun(h, h.brief("collapsed.md", collapsed));
  assert.equal(run.status, 0, run.stderr);

  const noVerify = h.brief("collapsed-no-verify.md", collapsed.replace("VERIFY:", "Run:"));
  assertRefused(h, dryRun(h, noVerify), /does not name required field VERIFY/);
});

test("a merger brief needs STEPS in place of VERIFY", (t) => {
  const h = host(t);
  const merger = IMPLEMENTER_BRIEF.replace(/^VERIFY /m, "STEPS  ");

  assert.equal(dryRun(h, h.brief("merger.md", merger), "merger").status, 0);
  assertRefused(h, dryRun(h, h.brief("merger-verify.md", IMPLEMENTER_BRIEF), "merger"), /field STEPS/);
});

test("a brief whose KIND disagrees with the launch is refused", (t) => {
  const h = host(t);
  const owner = h.brief("owner.md", IMPLEMENTER_BRIEF.replace("KIND         delegate", "KIND         owner"));

  assertRefused(h, dryRun(h, owner), /KIND owner, but the launch is --kind delegate/);
});

test("a brief with an unfilled slot is refused and the line printed", (t) => {
  const h = host(t);
  const receipts = IMPLEMENTER_BRIEF.replace("ticket 12 (user)", "Intermediate PR receipts: undefined.");
  const doubled = IMPLEMENTER_BRIEF.replace("abc123)", "abc123), diff against refs/remotes/origin/origin/staging");

  assertRefused(h, dryRun(h, h.brief("receipts.md", receipts)), /:5: unfilled placeholder: CONTEXT +Intermediate PR receipts: undefined\./);
  assertRefused(h, dryRun(h, h.brief("doubled.md", doubled)), /unfilled placeholder: .*refs\/remotes\/origin\/origin\/staging/);

  for (const [name, slot] of [
    ["object.md", "[object Object]"],
    ["template.md", "${unit}"],
    ["angle.md", "<sha>"],
    ["path.md", "`reviews/undefined/report.md`"],
  ] as const) {
    const text = IMPLEMENTER_BRIEF.replace("45 minutes", `45 minutes, see ${slot}`);
    assertRefused(h, dryRun(h, h.brief(name, text)), /unfilled placeholder/);
  }
});

test("code quoted in a brief does not trip the placeholder check", (t) => {
  const h = host(t);
  const quoted = `${IMPLEMENTER_BRIEF}
The failing line, quoted from src/upload/client.ts:

\`\`\`ts
const tag = \`closed:\${reason.name}\`;
const same = (x) => x;
if (value === undefined) return <Upload id={id} />;
\`\`\`

Inline \`if (x === undefined)\` and the autolink <https://example.com/a> are fine too.
`;

  const run = dryRun(h, h.brief("quoted.md", quoted));
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes("closed:${reason.name}"), run.stdout);
});

// A repository whose origin is a local bare repository holding chunk/exists.
function repository(h: Host): string {
  const origin = join(h.dir, "origin.git");
  const work = join(h.dir, "work");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });

  git(h.dir, "init", "--quiet", "--bare", origin);
  git(h.dir, "init", "--quiet", work);
  git(work, "commit", "--quiet", "--allow-empty", "-m", "start");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/chunk/exists");

  return work;
}

test("a brief naming an input branch the remote lacks is refused", (t) => {
  const h = host(t);
  const work = repository(h);
  const named = (branch: string) =>
    IMPLEMENTER_BRIEF.replace("abc123)", `abc123), the integration branch origin/${branch}`);
  const based = (branch: string) =>
    IMPLEMENTER_BRIEF.replace("on branch unit-1", `on branch unit-1, based on \`${branch}\``);

  assertRefused(h, dryRun(h, h.brief("a.md", named("chunk/does-not-exist")), "implementer", work), /origin has no branch chunk\/does-not-exist/);
  assertRefused(h, dryRun(h, h.brief("b.md", based("chunk/does-not-exist")), "implementer", work), /origin has no branch chunk\/does-not-exist/);
  assert.equal(dryRun(h, h.brief("c.md", named("chunk/exists")), "implementer", work).status, 0);
  assert.equal(dryRun(h, h.brief("d.md", based("chunk/exists")), "implementer", work).status, 0);
});

test("a branch the unit creates is not checked", (t) => {
  const h = host(t);
  const work = repository(h);
  const creates = IMPLEMENTER_BRIEF.replace(
    "on branch unit-1",
    "creates branch chunk/new-unit, based on origin/chunk/exists",
  );

  const run = dryRun(h, h.brief("creates.md", creates), "implementer", work);
  assert.equal(run.status, 0, run.stderr);
});

test("a spawn holds while the host is saturated and starts once it is not", async (t) => {
  const h = host(t);
  const brief = h.brief("brief.md", IMPLEMENTER_BRIEF);
  const loadavg = h.env.PI_LAUNCH_LOADAVG ?? "";
  writeFileSync(loadavg, "41.00 30.00 20.00 9/900 1\n");

  const child = spawn(
    process.execPath,
    [LAUNCH, ...baseArgs(h, brief), "--max-load", "16", "--min-mem-gib", "2", "--poll-seconds", "0.1"],
    { cwd: h.dir, env: h.env },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<number | null>((done) => child.on("close", done));

  for (let tries = 0; !stderr.includes("holding") && tries < 100; tries += 1)
    await new Promise((done) => setTimeout(done, 50));

  assert.match(stderr, /holding, host saturated: load 41\.00 \(max 16\), MemAvailable 32\.0 GiB \(min 2 GiB\)/);
  assert.equal(existsSync(h.marker), false, "held, so no Pi process yet");

  replaceAtomically(loadavg, "3.00 30.00 20.00 9/900 1\n");

  assert.equal(await exited, 0, stderr);
  assert.match(stderr, /admitted: load 3\.00 \(max 16\)/);
  assert.equal(existsSync(h.marker), true, "the spawn started once the host freed up");
});

test("an empty load file refuses the spawn instead of admitting it", (t) => {
  const h = host(t);
  const brief = h.brief("brief.md", IMPLEMENTER_BRIEF);
  const loadavg = h.env.PI_LAUNCH_LOADAVG ?? "";

  for (const text of ["", " \n"]) {
    writeFileSync(loadavg, text);
    const run = launch(h, baseArgs(h, brief));

    assert.doesNotMatch(run.stderr, /admitted/);
    assertRefused(h, run, /could not parse the load in \S*loadavg/);
  }
});

test("a spawn holds while MemAvailable is below the floor", (t) => {
  const h = host(t);
  const brief = h.brief("brief.md", IMPLEMENTER_BRIEF);
  const run = spawnSync(
    process.execPath,
    [LAUNCH, ...baseArgs(h, brief), "--min-mem-gib", "64", "--poll-seconds", "5", "--dry-run"],
    { cwd: h.dir, env: h.env, encoding: "utf8", timeout: 1500 },
  );

  assert.match(run.stderr, /holding, host saturated: .*MemAvailable 32\.0 GiB \(min 64 GiB\)/);
  assert.equal(run.stdout, "", "a held launch prints no command");
});

// The block that a skill tells the lead to run, with its slots filled for a dry run.
function skillLaunch(path: string, heading: RegExp): string {
  const skill = readFileSync(path, "utf8");
  const section = skill.split(heading)[1] ?? "";
  const block = /```bash\n([\s\S]*?)```/.exec(section)?.[1];
  assert.ok(block, `${path} has a bash launch block`);
  assert.match(block, /subagents\/scripts\/launch\.ts/, "the block runs the launcher");

  return block;
}

test("code-review's panel launches every seat through the launcher with the orders, and fails when a seat fails", (t) => {
  const h = host(t);
  const reviews = join(h.dir, "reviews");
  mkdirSync(reviews);
  writeFileSync(join(reviews, "standards.brief.md"), "Review the diff `git diff main...HEAD` through the standards lens.\n");

  const skillDir = new URL("../../../code-review", import.meta.url).pathname;
  const filled = skillLaunch(CODE_REVIEW_SKILL, /^## 5\. Launch the panel$/m)
    .replaceAll("$HOME/.pi/agent/skills/subagents/scripts/launch.ts", `${process.execPath} ${LAUNCH}`)
    .replaceAll("<this skill's directory>", skillDir)
    .replaceAll("<review folder>", reviews)
    .replaceAll("<model>", "openai/gpt-6.1-sol")
    .replaceAll("<orders file, or none>", h.orders)
    .replaceAll("--thinking high", "--thinking high --dry-run");
  // bg_start runs its command with /bin/sh, so the block must run there.
  const panel = () => spawnSync("sh", ["-c", filled], { cwd: h.dir, env: h.env, encoding: "utf8" });

  const refused = panel();
  assert.equal(refused.status, 1, "a seat without a brief fails the panel");
  assert.match(readFileSync(join(reviews, "panel.exits"), "utf8"), /^spec-fidelity exit 2$/m);
  assert.match(readFileSync(join(reviews, "spec-fidelity.log"), "utf8"), /launch: refused/);

  writeFileSync(join(reviews, "spec-fidelity.brief.md"), "Review the diff `git diff main...HEAD` against the spec.\n");
  const run = panel();
  assert.equal(run.status, 0, `${filled}\n${run.stdout}\n${run.stderr}`);
  for (const persona of ["standards", "spec-fidelity"]) {
    const report = readFileSync(join(reviews, `${persona}.md`), "utf8");
    assert.ok(report.includes("2. No production access. (user)"), report);
    assert.match(report, new RegExp(`personas/${persona}\\.md`));
  }
});

test("the subagents skill's launcher block runs as written", (t) => {
  const h = host(t);
  const state = join(h.dir, "state");
  mkdirSync(state);
  writeFileSync(join(state, "orders.md"), readFileSync(h.orders, "utf8"));
  writeFileSync(join(state, "brief.md"), IMPLEMENTER_BRIEF);

  const filled = skillLaunch(SUBAGENTS_SKILL, /^## Launch from a brief$/m)
    .replaceAll("$HOME/.pi/agent/skills/subagents/scripts/launch.ts", `${process.execPath} ${LAUNCH}`)
    .replaceAll("<delegate|owner>", "delegate")
    .replaceAll("<role>", "implementer")
    .replaceAll("<state folder>", state)
    .replaceAll("<brief>", "brief")
    .replaceAll("<model>", "anthropic/claude-opus-5-5")
    .replaceAll("<level>", "medium")
    .replaceAll("<short assignment>", "unit-1")
    .replace(/\n$/, " --dry-run\n");

  const run = spawnSync("bash", ["-c", filled], { cwd: h.dir, env: h.env, encoding: "utf8" });
  assert.equal(run.status, 0, `${filled}\n${run.stderr}`);
  assert.ok(run.stdout.includes("1. Base branch is main. (user)"), run.stdout);
});
