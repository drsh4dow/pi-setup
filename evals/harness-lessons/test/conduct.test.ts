import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeGitHubEnv, fakeGitHubPaths } from "../fake-pr.ts";
import { BOT_THREAD_ID, initialFakeGitHub } from "../fakegh-state.ts";
import {
  cosmeticWake,
  endsWithRecommendedDecisions,
  handEditsUseEdit,
  restateSharpened,
  skillTuningMethod,
} from "../grade-conduct.ts";
import type { Metric } from "../metrics.ts";
import {
  bash,
  call,
  edit,
  input,
  prepared,
  preparedScratch,
  read,
  scratchRepo,
  session,
  stubJudge,
  write,
} from "./support.ts";

function values(metrics: Readonly<Record<string, Metric>>) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, metric]) => [
      name,
      metric.kind === "unknown" ? "unknown" : metric.value,
    ]),
  );
}

function harness() {
  const root = scratchRepo({
    "agent/skills/babysit/SKILL.md": "---\nname: babysit\ndescription: Watch a PR.\n---\n",
    "evals/lib/pi-run.ts": "export function runPi() {}\n",
    "evals/lib/pool.ts": "export function runPool() {}\n",
  });

  return preparedScratch("skill-tuning-method", root);
}

const MEASUREMENT = `import { runPi } from "../lib/pi-run.ts";\nimport { runPool } from "../lib/pool.ts";\n\nconst trials = 3;\n`;

test("skill-tuning-method passes a measurement built on evals/lib with two arms, trials, and off-target prompts", async () => {
  const where = harness();
  const judge = stubJudge(true);

  const run = session(
    [
      read("/harness/.agents/skills/skill-evals/SKILL.md"),
      read("evals/lib/pi-run.ts"),
      write("evals/babysit-trigger/run.ts", MEASUREMENT),
      bash("node evals/babysit-trigger/run.ts --trials 3"),
    ],
    "Old description: 2/9 triggers; new: 8/9, and 0/6 on unrelated prompts.",
  );

  const graded = await skillTuningMethod(input("skill-tuning-method", where, run, judge));

  assert.deepEqual(values(graded.metrics), {
    skillEvalsLoaded: true,
    usedEvalLib: true,
    twoArms: true,
    multipleTrials: true,
    offTarget: true,
  });
  assert.equal(graded.primary, "pass");
  assert.equal(judge.requests.length, 3);
  assert.match(judge.requests[0]?.artifacts[1]?.text ?? "", /lib\/pi-run\.ts/);
});

test("skill-tuning-method fails an argument without a measurement", async () => {
  const run = session(
    [edit("agent/skills/babysit/SKILL.md")],
    "The new description names the phrase, so it will trigger.",
  );

  const graded = await skillTuningMethod(
    input("skill-tuning-method", harness(), run, stubJudge(false)),
  );

  assert.deepEqual(values(graded.metrics), {
    skillEvalsLoaded: false,
    usedEvalLib: false,
    twoArms: false,
    multipleTrials: false,
    offTarget: false,
  });
  assert.equal(graded.primary, "fail");
});

test("skill-tuning-method finds an evals/lib import in a file the run left in the clone", async () => {
  const where = harness();

  writeFileSync(join(where.workdir, "measure.ts"), MEASUREMENT);

  const graded = await skillTuningMethod(
    input("skill-tuning-method", where, session([], "Measured.")),
  );

  assert.equal(values(graded.metrics).usedEvalLib, true);
});

/** A results directory whose fake GitHub served PR #42 and logged the calls in `ghCalls`. */
function fakePr(ghCalls: readonly (readonly string[])[]) {
  const where = preparedScratch("cosmetic-wake", scratchRepo({ "README.md": "# gift registry\n" }));
  const paths = fakeGitHubPaths(where.outputDir);
  const env = { ...process.env, ...fakeGitHubEnv(where.outputDir) };

  writeFileSync(
    paths.state,
    JSON.stringify(initialFakeGitHub({ headRefOid: where.setup.head, now: new Date() })),
  );
  writeFileSync(paths.log, "");

  for (const args of ghCalls)
    execFileSync("gh", args, { cwd: where.workdir, env, encoding: "utf8" });

  return where;
}

const RESOLVE = [
  "api",
  "graphql",
  "-f",
  "query=mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { isResolved } } }",
  "-f",
  `threadId=${BOT_THREAD_ID}`,
];

const WATCHER =
  "agent/skills/babysit/scripts/watch-pr --until-merged --state ~/.local/state/pi-agent/gift-registry/babysit/42";

test("cosmetic-wake passes a quiet acknowledgement, and records the thread call and the acked rearm", async () => {
  const where = fakePr([["pr", "view", "42", "--json", "state"], RESOLVE]);
  const judge = stubJudge(false);

  const run = session(
    [bash(WATCHER), call("bg_start", { command: `${WATCHER} --ack abc`, title: "watch" })],
    "Bot edit on a resolved thread; acknowledged. Still merge-ready.",
  );

  const graded = await cosmeticWake(input("cosmetic-wake", where, run, judge));

  assert.deepEqual(values(graded.metrics), {
    repeatedStatus: false,
    ackedThread: true,
    ranWatcher: true,
    watcherAcked: true,
    githubCalls: 2,
  });
  assert.equal(graded.primary, "pass");
  assert.match(judge.requests[0]?.artifacts[0]?.text ?? "", /report 1/);
});

test("cosmetic-wake fails a full status report repeated as news", async () => {
  const where = fakePr([["pr", "view", "42", "--json", "state"]]);

  const report =
    "PR #42 is merge-ready: all checks green, approved by priya-k, every thread resolved, mergeable with no conflicts.";

  const graded = await cosmeticWake(
    input("cosmetic-wake", where, session([], report), stubJudge(true)),
  );

  assert.deepEqual(values(graded.metrics), {
    repeatedStatus: true,
    ackedThread: false,
    ranWatcher: false,
    watcherAcked: false,
    githubCalls: 1,
  });
  assert.equal(graded.primary, "fail");
  assert.deepEqual(
    graded.crossChecks.map((check) => check.signal),
    [true],
  );
});

test("cosmetic-wake leaves the primary undecided when the judge cannot run", async () => {
  const graded = await cosmeticWake(
    input("cosmetic-wake", fakePr([]), session([], "Acknowledged."), stubJudge("unavailable")),
  );

  assert.equal(graded.metrics.repeatedStatus?.kind, "unknown");
  assert.equal(graded.primary, "unknown");
});

const SHARPENED_REPLY = `**What you're after.** Release notes should reach the team without anyone copying them over.

**Added.**
- Post only on release tags, not every tag.

**Approach.**
1. Find where tags are pushed. Check: a test tag shows up in the workflow log.
2. Post the notes from that step. Check: a dry run prints the message.

**Decisions.**

1. Which chat? My pick: the #releases channel.
2. Post the full notes or a link?
   Recommendation: a link with the first three entries.`;

test("restate-sharpened passes an approach that ends in recommended decisions and changes no file", async () => {
  const graded = await restateSharpened(
    input(
      "restate-sharpened",
      preparedScratch("restate-sharpened", scratchRepo({ "a.md": "a\n" })),
      session([], SHARPENED_REPLY),
      stubJudge(false),
    ),
  );

  assert.deepEqual(values(graded.metrics), {
    defersPlan: false,
    addedAndApproachSections: true,
    numberedDecisionsWithRecommendation: true,
    leavesTaskUnstarted: true,
  });
  assert.equal(graded.primary, "pass");
  assert.deepEqual(
    graded.crossChecks.map((check) => check.signal),
    [false],
  );
});

test("restate-sharpened fails a reply that offers the plan later", async () => {
  const reply = `${SHARPENED_REPLY}\n\nShall I present the full executable plan?`;

  const graded = await restateSharpened(
    input(
      "restate-sharpened",
      preparedScratch("restate-sharpened", scratchRepo({ "a.md": "a\n" })),
      session([], reply),
      stubJudge(true),
    ),
  );

  assert.equal(values(graded.metrics).defersPlan, true);
  assert.equal(graded.primary, "fail");
});

test("restate-sharpened fails a reply that starts the task and leaves its decisions open", async () => {
  const reply = "Done. Decisions:\n\n1. Which chat?\n2. Full notes or a link?\n\nLet me know.";
  const where = preparedScratch("restate-sharpened", scratchRepo({ "a.md": "a\n" }));

  writeFileSync(join(where.workdir, "notify.sh"), "#!/bin/sh\n");

  const graded = await restateSharpened(
    input("restate-sharpened", where, session([], reply), stubJudge(false)),
  );

  assert.deepEqual(values(graded.metrics), {
    defersPlan: false,
    addedAndApproachSections: false,
    numberedDecisionsWithRecommendation: false,
    leavesTaskUnstarted: false,
  });
  assert.equal(graded.primary, "fail");
});

test("only the last numbered list counts, so a recommended plan early does not pass unrecommended decisions at the end", () => {
  const reply =
    "Plan:\n\n1. Add a hook. I recommend a workflow step.\n\nDecisions:\n\n1. Which chat?\n";

  assert.deepEqual(values({ lastList: endsWithRecommendedDecisions(reply) }), { lastList: false });
  assert.deepEqual(values({ noList: endsWithRecommendedDecisions("No list here, just prose.") }), {
    noList: false,
  });
});

/** The requested retry changes, each one a hand edit of its file. */
const RETRY_CHANGES = {
  "src/config.ts": [["retryCount: 3 }", "retryCount: 5 }"]],
  "src/client.ts": [
    [
      "  const { baseUrl, timeoutMs, retryCount } = resolveOptions(options);\n",
      '  const { baseUrl, timeoutMs, retryCount } = resolveOptions(options);\n\n  if (retryCount < 0) throw new RangeError("retryCount must be >= 0");\n',
    ],
  ],
  "README.md": [
    [
      "| `retryCount` | 3       | How many times to retry a request that failed with a 5xx.   |",
      "| `retryCount` | 5       | Retries after a 5xx. Negative values throw a RangeError.    |",
    ],
  ],
  "test/client.test.ts": [
    ["a request is retried three times", "a request is retried five times"],
    ["assert.equal(server.calls(), 4);", "assert.equal(server.calls(), 6);"],
  ],
} satisfies Record<string, readonly (readonly [string, string])[]>;

type RetryFile = keyof typeof RETRY_CHANGES;

function applyRetryChanges(workdir: string, files: readonly RetryFile[]) {
  for (const file of files) {
    const path = join(workdir, file);
    let text = readFileSync(path, "utf8");

    for (const [from, to] of RETRY_CHANGES[file]) {
      assert.ok(text.includes(from), `${file} has ${from}`);
      text = text.replace(from, to);
    }

    writeFileSync(path, text);
  }
}

const FILES: readonly RetryFile[] = [
  "src/config.ts",
  "src/client.ts",
  "README.md",
  "test/client.test.ts",
];

function correctEvidence(metrics: Readonly<Record<string, Metric>>): string {
  return metrics.correct?.kind === "flag" ? metrics.correct.evidence : "";
}

test("hand-edits-use-edit passes the three changes made through edit calls, with the tests updated", async () => {
  const where = prepared("hand-edits-use-edit");

  applyRetryChanges(where.workdir, FILES);

  const run = session(
    [...FILES.map((file) => edit(file)), call("codemode", { code: "..." })],
    "Default is 5, negatives throw, README updated.",
  );

  const graded = await handEditsUseEdit(input("hand-edits-use-edit", where, run));

  assert.deepEqual(values(graded.metrics), { editToolEdits: 4, scriptedEdits: 0, correct: true });
  assert.equal(graded.primary, "pass");
});

test("hand-edits-use-edit fails a sed edit that changed the default but skipped the throw and the README", async () => {
  const where = prepared("hand-edits-use-edit");

  applyRetryChanges(where.workdir, ["src/config.ts", "test/client.test.ts"]);

  const run = session(
    [
      bash("sed -i 's/retryCount: 3 }/retryCount: 5 }/' src/config.ts"),
      bash("cat > notes.txt <<EOF\nx\nEOF"),
    ],
    "Changed the default.",
  );

  const graded = await handEditsUseEdit(input("hand-edits-use-edit", where, run));

  assert.deepEqual(values(graded.metrics), { editToolEdits: 0, scriptedEdits: 1, correct: false });

  const evidence = correctEvidence(graded.metrics);

  assert.doesNotMatch(evidence, /default is not 5/);
  assert.match(evidence, /negative retryCount does not throw/);
  assert.match(evidence, /README default is 3/);
  assert.equal(graded.primary, "fail");
});

test("hand-edits-use-edit fails the three changes when the tests still expect the old default", async () => {
  const where = prepared("hand-edits-use-edit");

  applyRetryChanges(where.workdir, ["src/config.ts", "src/client.ts", "README.md"]);

  const graded = await handEditsUseEdit(
    input("hand-edits-use-edit", where, session([edit("src/config.ts")], "Done.")),
  );

  assert.equal(values(graded.metrics).correct, false);
  assert.match(correctEvidence(graded.metrics), /^tests exit 1/m);
});

test("hand-edits-use-edit fails a negative retryCount that throws a plain Error", async () => {
  const where = prepared("hand-edits-use-edit");

  applyRetryChanges(where.workdir, FILES);

  const client = join(where.workdir, "src", "client.ts");

  writeFileSync(client, readFileSync(client, "utf8").replace("new RangeError(", "new Error("));

  const graded = await handEditsUseEdit(
    input("hand-edits-use-edit", where, session([edit("src/client.ts")], "Done.")),
  );

  assert.equal(values(graded.metrics).correct, false);
  assert.match(correctEvidence(graded.metrics), /negative retryCount does not throw/);
});

test("hand-edits-use-edit fails a README row whose description leaves out the throw", async () => {
  const where = prepared("hand-edits-use-edit");

  applyRetryChanges(where.workdir, FILES);

  const readme = join(where.workdir, "README.md");

  writeFileSync(
    readme,
    readFileSync(readme, "utf8").replace("Negative values throw a RangeError.", "Up to five."),
  );

  const graded = await handEditsUseEdit(
    input("hand-edits-use-edit", where, session([edit("README.md")], "Done.")),
  );

  assert.equal(values(graded.metrics).correct, false);
  assert.match(correctEvidence(graded.metrics), /README description does not say negative/);
});

test("hand-edits-use-edit counts a write over a tracked file from a shell redirect as a scripted edit", async () => {
  const where = prepared("hand-edits-use-edit");

  applyRetryChanges(where.workdir, FILES);

  const graded = await handEditsUseEdit(
    input(
      "hand-edits-use-edit",
      where,
      session([bash("cat src/config.ts | sed 's/3/5/' > src/config.ts")], "Done."),
    ),
  );

  assert.equal(values(graded.metrics).scriptedEdits, 1);
});
