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

// The harness's agent directory, which holds the generated role prompts and the skills.
const AGENT_DIR = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");

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
  const [skillHeading, skill, heading, orders, ...rest] = appends;

  assert.equal(argv[argv.indexOf("--system-prompt") + 1], `${AGENT_DIR}/system/generated/delegate/implementer.md`);
  assert.ok(argv.includes("--no-skills"), argv.join(" "));
  assert.deepEqual(flagValues(argv, "--skill"), [`${AGENT_DIR}/skills/tdd`]);
  assert.match(skillHeading ?? "", /^# Skill: tdd\n/, "a literal heading labels the skill");
  assert.equal(skill, `${AGENT_DIR}/skills/tdd/SKILL.md`, "the skill travels as a path Pi reads at start");
  assert.match(heading ?? "", /^# Standing orders\n/, "a literal heading labels the orders");
  assert.ok(heading?.includes(h.orders), "the heading names the orders file");
  assert.equal(orders, h.orders, "the orders travel as a path Pi reads at start");
  assert.deepEqual(rest, []);
  assert.equal(argv[argv.indexOf("--name") + 1], "subagent: unit-1");
});

function flagValues(words: readonly string[], flag: string): string[] {
  return words.flatMap((word, index) => (word === flag ? [words[index + 1] ?? ""] : []));
}

function commandWords(run: Run): string[] {
  const command = /^command: pi-subagent (.*)$/m.exec(run.stdout)?.[1];
  assert.ok(command, run.stdout);

  return command.split(" ");
}

// The kind of each role, from the subagents skill's role table: the babysitter owns its unit.
const ROLE_KINDS = {
  implementer: "delegate",
  explorer: "delegate",
  verifier: "delegate",
  merger: "delegate",
  "pr-writer": "delegate",
  "live-verifier": "delegate",
  persona: "delegate",
  assignment: "delegate",
  "brief-auditor": "delegate",
  babysitter: "owner",
} as const;

function roleBrief(role: keyof typeof ROLE_KINDS): string {
  const kind = ROLE_KINDS[role];

  if (role === "persona" || role === "assignment") return "Review the diff `git diff main...HEAD`.\n";

  const brief = IMPLEMENTER_BRIEF.replace("KIND         delegate", `KIND         ${kind}`);

  return role === "merger" ? brief.replace(/^VERIFY /m, "STEPS  ") : brief;
}

for (const role of Object.keys(ROLE_KINDS) as (keyof typeof ROLE_KINDS)[]) {
  test(`the ${role} role runs on its role prompt alone, with no kind file appended`, (t) => {
    const h = host(t);
    const kind = ROLE_KINDS[role];
    const args = baseArgs(h, h.brief("brief.md", roleBrief(role)), role);
    args[args.indexOf("--kind") + 1] = kind;

    const run = launch(h, [...args, "--dry-run"]);
    assert.equal(run.status, 0, run.stderr);

    const words = commandWords(run);
    const prompt = `${AGENT_DIR}/system/generated/${kind}/${role}.md`;

    assert.deepEqual(flagValues(words, "--system-prompt"), [prompt]);
    assert.ok(words.includes("--no-skills"), "skill discovery is off");
    assert.doesNotMatch(run.stdout, /subagents\/(unattended|delegate|owner)\.md/, "no kind file is appended");
    assert.ok(run.stdout.includes(`--- system prompt: ${prompt} ---\n${readFileSync(prompt, "utf8").trimEnd()}\n`), run.stdout);
    assert.doesNotMatch(run.stdout, /<collaboration>|<skill_workflow>|<router>/, "no general-mode part");
  });
}

test("a child loads exactly the skills its brief's SKILLS field names", (t) => {
  const h = host(t);
  const skills = IMPLEMENTER_BRIEF.replace(
    "SKILLS       tdd",
    "SKILLS       **tdd** (red first, then green), `unslop`\n             and writing-good-commits",
  );
  const run = dryRun(h, h.brief("skills.md", skills));
  assert.equal(run.status, 0, run.stderr);

  const dirs = ["tdd", "unslop", "writing-good-commits"].map((name) => `${AGENT_DIR}/skills/${name}`);

  assert.deepEqual(flagValues(commandWords(run), "--skill"), dirs);
  assert.ok(
    run.stdout.includes(`--- skills ---\ntdd\t${dirs[0]}\nunslop\t${dirs[1]}\nwriting-good-commits\t${dirs[2]}\n`),
    run.stdout,
  );
});

test("a free-form brief's SKILLS line ends at the prose after it", (t) => {
  const h = host(t);
  const brief = h.brief(
    "free-skills.md",
    "Check what this run loads.\n\nSKILLS tdd, unslop\n\n1. Reply with the names in your skill table, exactly as listed.\n2. Read the skill and write one commit subject.\n",
  );
  const run = dryRun(h, brief, "assignment");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(flagValues(commandWords(run), "--skill"), [
    `${AGENT_DIR}/skills/tdd`,
    `${AGENT_DIR}/skills/unslop`,
  ]);
});

test("a brief whose SKILLS is none, or that has no SKILLS field, loads no skill", (t) => {
  const h = host(t);
  const none = h.brief("none.md", IMPLEMENTER_BRIEF.replace("SKILLS       tdd", "SKILLS       none: the unit is one command"));

  for (const run of [dryRun(h, none), dryRun(h, h.brief("free.md", roleBrief("assignment")), "assignment")]) {
    assert.equal(run.status, 0, run.stderr);
    assert.ok(commandWords(run).includes("--no-skills"), run.stdout);
    assert.deepEqual(flagValues(commandWords(run), "--skill"), []);
  }
});

test("a skill name resolves to the harness's skill first, then to the launch directory's", (t) => {
  const h = host(t);
  const work = join(h.dir, "project");

  for (const name of ["local-check", "tdd"]) {
    mkdirSync(join(work, ".agents/skills", name), { recursive: true });
    writeFileSync(join(work, ".agents/skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  }

  const brief = h.brief("local.md", IMPLEMENTER_BRIEF.replace("SKILLS       tdd", "SKILLS       tdd, local-check"));
  const run = dryRun(h, brief, "implementer", work);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(flagValues(commandWords(run), "--skill"), [
    `${AGENT_DIR}/skills/tdd`,
    join(work, ".agents/skills/local-check"),
  ]);
});

// The system prompt Pi builds from the argv the fake pi-subagent received: the --system-prompt
// file, then each --append-system-prompt, read as a file when the value is a path that exists
// and taken as literal text otherwise. The skill table Pi adds is left out, because Pi drops
// every skill with `disable-model-invocation: true` from it.
function recordedSystemPrompt(h: Host): string {
  const argv = readFileSync(`${h.marker}.argv`, "utf8").split("\0");
  const read = (value: string) => (existsSync(value) ? readFileSync(value, "utf8") : value);

  return [
    ...flagValues(argv, "--system-prompt"),
    ...flagValues(argv, "--append-system-prompt"),
  ].map(read).join("\n\n");
}

test("a named skill hidden from the model's skill table is still in the child's system prompt", (t) => {
  const h = host(t);
  const work = join(h.dir, "project");
  const hidden = join(work, ".agents/skills/hidden-check");
  mkdirSync(hidden, { recursive: true });
  writeFileSync(
    join(hidden, "SKILL.md"),
    "---\nname: hidden-check\ndescription: A check the router hides.\ndisable-model-invocation: true\n---\n\nRun the hidden check before you commit.\n",
  );

  const brief = h.brief("hidden.md", IMPLEMENTER_BRIEF.replace("SKILLS       tdd", "SKILLS       hidden-check, tdd"));
  const run = launch(h, baseArgs(h, brief), work);
  assert.equal(run.status, 0, run.stderr);

  const prompt = recordedSystemPrompt(h);

  for (const [name, file, body] of [
    ["hidden-check", join(hidden, "SKILL.md"), "Run the hidden check before you commit."],
    ["tdd", `${AGENT_DIR}/skills/tdd/SKILL.md`, "# Test-driven development"],
  ] as const) {
    assert.match(prompt, new RegExp(`^# Skill: ${name}$`, "m"), `a heading names ${name}`);
    assert.ok(prompt.includes(file), `the prompt names ${file}`);
    assert.ok(prompt.includes(body), `the prompt holds the text of ${file}`);
  }
});

test("a brief naming an unknown skill is refused before launch", (t) => {
  const h = host(t);
  const brief = h.brief("unknown.md", IMPLEMENTER_BRIEF.replace("SKILLS       tdd", "SKILLS       tdd, no-such-skill"));

  for (const args of [[...baseArgs(h, brief), "--dry-run"], baseArgs(h, brief)]) {
    const run = launch(h, args);

    assertRefused(h, run, /launch: refused: /);
    assert.ok(
      run.stderr.includes(
        `launch: refused: ${brief}: SKILLS names no-such-skill, which is no skill in ${AGENT_DIR}/skills or ${h.dir}/.agents/skills\n`,
      ),
      run.stderr,
    );
  }
});

test("a launch whose --kind is not its role's kind is refused", (t) => {
  const h = host(t);
  const owner = h.brief("owner.md", IMPLEMENTER_BRIEF.replace("KIND         delegate", "KIND         owner"));
  const asOwner = baseArgs(h, owner);
  asOwner[asOwner.indexOf("--kind") + 1] = "owner";

  const run = launch(h, asOwner);
  assertRefused(h, run, /launch: refused: role implementer runs as delegate, but the launch is --kind owner\n/);

  const babysitter = baseArgs(h, h.brief("b.md", IMPLEMENTER_BRIEF), "babysitter");
  assertRefused(h, launch(h, babysitter), /launch: refused: role babysitter runs as owner, but the launch is --kind delegate\n/);
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
