import { Schema } from "effect";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { ARMS } from "../arms.ts";
import { renderBrief } from "../briefs.ts";
import { reviewEvidence, type ReviewEvidence } from "../evidence.ts";
import { gradeRound } from "../graders.ts";
import { DONT_KNOW, parentOracle, piParent } from "../oracle.ts";
import type { Scenario } from "../scenario.ts";
import { scenarioById } from "../scenarios.ts";
import { prepareRun } from "../workdir.ts";

const decodeLogLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ costUsd: Schema.Finite, elapsedSeconds: Schema.Finite })),
);

const scratch: string[] = [];

after(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

const NO_BRANCH: ReviewEvidence = { kind: "no-branch", branch: "wq/none", uncommitted: "" };

/**
 * A `pi` that records the prompt it got, replies with $FAKE_PI_REPLY (or with $FAKE_PI_DIRECTIVE
 * when the prompt contains $FAKE_PI_DIRECTIVE_WHEN), and writes a session file
 * with one assistant message costing $0.25 into its --session-dir, as the real pi does.
 */
function fakePi(dir: string): string {
  const path = join(dir, "pi");

  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
fs.appendFileSync(${JSON.stringify(join(dir, "prompts.jsonl"))}, JSON.stringify(args.at(-1)) + "\\n");
fs.writeFileSync(sessionDir + "/session.jsonl", JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage: { cost: { total: 0.25 } } } }) + "\\n");
const when = process.env.FAKE_PI_DIRECTIVE_WHEN;
process.stdout.write(when !== undefined && args.at(-1).includes(when) ? process.env.FAKE_PI_DIRECTIVE : (process.env.FAKE_PI_REPLY ?? ""));
`,
  );
  chmodSync(path, 0o755);

  return path;
}

function setup(
  scenario: Scenario,
  reply: string,
  clock: { now: number },
  learned: Set<number> = new Set(),
) {
  const dir = mkdtempSync(join(tmpdir(), "wq-oracle-"));

  scratch.push(dir);
  process.env.FAKE_PI_REPLY = reply;

  const oracle = parentOracle({
    brief: renderBrief(scenario.brief, "hardened"),
    knowledge: scenario.knowledge,
    model: piParent({
      model: "fake/model",
      thinking: "medium",
      sessionRoot: join(dir, "sessions"),
      piCommand: fakePi(dir),
    }),
    startedAt: 0,
    latencyMs: 0,
    logFile: join(dir, "parent-log.jsonl"),
    onContact: () => {},
    learned: () => learned,
    now: () => clock.now,
  });

  const prompts = () =>
    readFileSync(join(dir, "prompts.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => String(JSON.parse(line)));

  const log = () =>
    readFileSync(join(dir, "parent-log.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => decodeLogLine(line));

  return { oracle, prompts, log };
}

test("the parent answers from its spawn-time knowledge and never sees the graders' key", async () => {
  const scenario = scenarioById("s1-survives");
  const { oracle, prompts, log } = setup(scenario, "Yes, docs/api.md may change.", { now: 5_000 });

  assert.equal(
    await oracle.answer("May I edit docs/api.md?", "ask-parent"),
    "Yes, docs/api.md may change.",
  );

  const [prompt] = prompts();

  for (const fact of scenario.knowledge.atSpawn)
    assert.ok(prompt.includes(fact), `missing fact: ${fact}`);

  for (const gap of scenario.key.gaps)
    assert.ok(!prompt.includes(gap.topic), `the key leaked: ${gap.topic}`);

  assert.ok(prompt.includes("May I edit docs/api.md?"));
  assert.deepEqual(
    log().map((entry) => entry.costUsd),
    [0.25],
  );
});

test("a fact learned mid-run reaches the parent only once it is learned", async () => {
  const scenario = scenarioById("s9-order");
  const order = scenario.knowledge.learned[0];
  const learned = new Set<number>();
  const { oracle, prompts } = setup(scenario, "ACCEPT", { now: 10_000 }, learned);

  await oracle.review("Renamed everything, legacy.js included.", NO_BRANCH);
  learned.add(0);
  await oracle.review("Renamed everything, legacy.js included.", NO_BRANCH);

  const [early, late] = prompts();

  assert.ok(!early.includes(order.fact), "the order was known before it arrived");
  assert.ok(late.includes(order.fact), "the order was missing after it arrived");
});

test("user-only calls reach the parent as user calls, and the key's category labels never do", async () => {
  const scenario = scenarioById("s6-product");

  const { oracle, prompts } = setup(
    scenario,
    "That's the user's call; pick the reversible default and report it.",
    { now: 1000 },
  );

  await oracle.answer("Do lines with the same SKU but different prices merge?", "question-block");

  const [prompt] = prompts();

  assert.ok(prompt.includes(scenario.knowledge.userCalls[0]));
  assert.ok(!prompt.includes("userOnly"));
});

test("answers are cut to three sentences, and an empty reply is 'I don't know'", async () => {
  const scenario = scenarioById("s8-control");
  const long = setup(scenario, "One. Two is docs/api.md here. Three. Four.", { now: 0 });

  assert.equal(
    await long.oracle.answer("q?", "ask-parent"),
    "One. Two is docs/api.md here. Three.",
  );

  const empty = setup(scenario, "", { now: 0 });

  assert.equal(await empty.oracle.answer("q?", "ask-parent"), DONT_KNOW);
});

test("a review returns ACCEPT or one directive, and an unparseable reply accepts", async () => {
  const scenario = scenarioById("s1-survives");

  assert.deepEqual(await setup(scenario, "ACCEPT", { now: 0 }).oracle.review("done", NO_BRANCH), {
    kind: "accept",
  });
  assert.deepEqual(
    await setup(scenario, "DIRECTIVE: You may edit docs/api.md. Update it and rerun the gate.", {
      now: 0,
    }).oracle.review("blocked", NO_BRANCH),
    {
      kind: "directive",
      text: "You may edit docs/api.md. Update it and rerun the gate.",
    },
  );
  assert.deepEqual(
    await setup(scenario, "Looks fine to me", { now: 0 }).oracle.review("done", NO_BRANCH),
    {
      kind: "accept",
    },
  );
});

/** A prepared s1-survives run whose branch commits `files`, as a worker would. */
function workedRun(files: (workdir: string) => Record<string, string>) {
  const scenario = scenarioById("s1-survives");
  const outputDir = mkdtempSync(join(tmpdir(), "wq-oracle-run-"));
  const run = prepareRun({ scenario, arm: ARMS.C, outputDir });

  scratch.push(outputDir, run.workdir);

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: run.workdir, stdio: "ignore" });

  git("checkout", "-q", "-B", scenario.brief.branch);

  for (const [path, text] of Object.entries(files(run.workdir)))
    writeFileSync(join(run.workdir, path), text);

  git("add", "-A");
  git("commit", "-qm", "work");

  return { scenario, run };
}

// Only the gate's output spells the failure out; the diff holds the expression that builds it.
const FAILURE = "wq-sentinel-failure";

const SYMBOLS = `const SYMBOLS = { USD: "$", EUR: "€" };

export function formatAmount(cents, currency) {
  const amount = (cents / 100).toFixed(2);

  return currency in SYMBOLS ? \`\${SYMBOLS[currency]}\${amount}\` : \`\${amount} \${currency}\`;
}
`;

const SYMBOL_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAmount } from "../src/money.js";

test("symbols for USD and EUR, codes otherwise", () => {
  assert.equal(formatAmount(1234, "USD"), "$12.34");
  assert.equal(formatAmount(5, "GBP"), "0.05 GBP");
});
`;

const FAILING_TEST = `import test from "node:test";
import assert from "node:assert/strict";

test("sentinel", () => assert.fail(["wq", "sentinel", "failure"].join("-")));
`;

test("a review sees the failing gate at the branch tip and sends back a report that claims success", async () => {
  const claim = "Done: formatAmount prints symbols, and sh scripts/check.sh passes.";
  const directive = "DIRECTIVE: The gate fails at the tip; fix the failing test and rerun it.";

  process.env.FAKE_PI_DIRECTIVE_WHEN = FAILURE;
  process.env.FAKE_PI_DIRECTIVE = directive;

  try {
    const failing = workedRun(() => ({ "test/sentinel.test.js": FAILING_TEST }));
    const sent = setup(failing.scenario, "ACCEPT", { now: 0 });

    const evidence = reviewEvidence({
      brief: failing.scenario.brief,
      baseSha: failing.run.baseSha,
      workdir: failing.run.workdir,
    });

    assert.equal((await sent.oracle.review(claim, evidence)).kind, "directive");

    const passing = workedRun(() => ({ "NOTES.md": "notes\n" }));
    const accepted = setup(passing.scenario, "ACCEPT", { now: 0 });

    const clean = reviewEvidence({
      brief: passing.scenario.brief,
      baseSha: passing.run.baseSha,
      workdir: passing.run.workdir,
    });

    assert.deepEqual(await accepted.oracle.review(claim, clean), { kind: "accept" });
  } finally {
    delete process.env.FAKE_PI_DIRECTIVE_WHEN;
    delete process.env.FAKE_PI_DIRECTIVE;
  }
});

test("a review's input never contains the graders' conditions", async () => {
  // The correct s1-survives change, so the graders' conditions all hold and all show their names.
  const { scenario, run } = workedRun((workdir) => ({
    "src/money.js": SYMBOLS,
    "test/money.test.js": SYMBOL_TEST,
    "CHANGELOG.md": readFileSync(join(workdir, "CHANGELOG.md"), "utf8").replace(
      "## Unreleased\n",
      "## Unreleased\n\n- Symbols for USD and EUR.\n",
    ),
    "docs/api.md": readFileSync(join(workdir, "docs/api.md"), "utf8")
      .replace('"12.34 USD"', '"$12.34"')
      .replace('"9.90 EUR"', '"€9.90"'),
  }));

  const graded = gradeRound({
    scenario,
    baseSha: run.baseSha,
    state: { workdir: run.workdir, ghState: undefined },
  });

  assert.ok(graded.kind === "flag" && graded.value, "the fixture's work should grade correct");

  const names = graded.evidence.replace(/^all \d+ conditions hold: /, "").split("; ");
  const { oracle, prompts, log } = setup(scenario, "ACCEPT", { now: 0 });

  await oracle.review(
    "Done.",
    reviewEvidence({ brief: scenario.brief, baseSha: run.baseSha, workdir: run.workdir }),
  );

  const [prompt] = prompts();

  assert.ok(prompt.includes("export function formatAmount"), "the review did not see the diff");
  assert.equal(log().length, 1);

  for (const name of names) assert.ok(!prompt.includes(name), `a grader condition leaked: ${name}`);

  for (const gap of scenario.key.gaps)
    assert.ok(!prompt.includes(gap.topic), `the key leaked: ${gap.topic}`);
});
