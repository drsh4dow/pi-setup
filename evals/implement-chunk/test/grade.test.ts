// The grader on synthetic run directories: it flags a run whose child loaded the live harness and
// drops it from the arm summary, reads the metrics from the records rather than any report, marks
// what the records cannot settle as unknown, and applies the pre-registered reading.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  gradeDirectory,
  reading,
  runIsolation,
  summarize,
  type ArmSummary,
  type GradedRun,
} from "../grade.ts";
import { initialFakeGitHub } from "../gh-state.ts";
import { isChangelogScopeStop, known, runMetrics, unknown, type RunMetrics } from "../metrics.ts";
import { ruleBreaks } from "../rule-breaks.ts";
import {
  ARM_APPENDIX,
  LIVE_APPENDIX,
  mergedPullRequest,
  sessionJsonl,
  writeRun,
} from "./run-dir.ts";

const scratch = mkdtempSync(join(tmpdir(), "ic-grade-test-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

describe("grade.ts", () => {
  const out = join(scratch, "out");

  writeRun(out, {
    arm: "baseline",
    trial: 1,
    childAddendum: ARM_APPENDIX,
    humanTurns: ["intake", "nudge", "re-ask"],
    resets: 2,
  });
  writeRun(out, {
    arm: "baseline",
    trial: 2,
    childAddendum: LIVE_APPENDIX,
    humanTurns: ["intake"],
    resets: 0,
  });

  test("flags a run whose child session carries the live harness's appendix, and keeps it out of the summary", async () => {
    const { runs, summaries } = await gradeDirectory(out);
    const wrong = runs.find((run) => run.trial === 2);

    assert.equal(runs.find((run) => run.trial === 1)?.isolation.ok, true);
    assert.equal(wrong?.isolation.ok, false);
    assert.match(
      wrong?.isolation.bad.map((bad) => bad.problems.join()).join() ?? "",
      /live harness/,
    );
    assert.equal(summaries[0].n, 1);
    assert.equal(summaries[0].invalid, 1);
  });

  test("drops a run whose arm repository gained a branch, naming the branch", async () => {
    const dir = join(scratch, "out-branch");

    writeRun(dir, {
      arm: "candidate",
      trial: 1,
      childAddendum: ARM_APPENDIX,
      humanTurns: [],
      resets: 0,
    });
    writeRun(dir, {
      arm: "candidate",
      trial: 2,
      childAddendum: ARM_APPENDIX,
      humanTurns: [],
      resets: 0,
      addedBranches: ["implement-chunk-tracker-linking"],
    });

    const { runs, summaries } = await gradeDirectory(dir);
    const tainted = runs.find((run) => run.trial === 2);

    assert.equal(runs.find((run) => run.trial === 1)?.integrity.ok, true);
    assert.equal(tainted?.integrity.ok, false);
    assert.match(tainted?.integrity.problems.join() ?? "", /implement-chunk-tracker-linking/);
    assert.deepEqual([summaries[0].n, summaries[0].invalid], [1, 1]);
  });

  test("drops a run whose child edited the arm's checkout, and one with no integrity record", async () => {
    const dir = join(scratch, "out-writes");

    writeRun(dir, {
      arm: "candidate",
      trial: 1,
      childAddendum: ARM_APPENDIX,
      humanTurns: [],
      resets: 0,
      childCalls: [
        {
          name: "edit",
          arguments: { path: "/home/u/.pi/.worktrees/revise/agent/prompts/implement-chunk.md" },
        },
      ],
    });
    writeRun(dir, {
      arm: "candidate",
      trial: 2,
      childAddendum: ARM_APPENDIX,
      humanTurns: [],
      resets: 0,
      noIntegrity: true,
    });

    const { runs } = await gradeDirectory(dir);

    const problems = (trial: number) =>
      runs.find((run) => run.trial === trial)?.integrity.problems.join() ?? "";

    assert.match(problems(1), /wrote outside the run: .*implement-chunk\.md/);
    assert.match(problems(2), /no integrity record/);
  });

  test("counts as final PRs only the chunk's own, not one opened after the close", async () => {
    const dir = writeRun(join(scratch, "out-scope"), {
      arm: "candidate",
      trial: 1,
      childAddendum: ARM_APPENDIX,
      humanTurns: [],
      resets: 0,
      chunkFinalPrs: [5],
    });

    const github = initialFakeGitHub({
      owner: "acme",
      repo: "tally",
      bare: "/b",
      ciDelayMs: 0,
      botDelayMs: 0,
    });

    writeFileSync(
      join(dir, "gh-state.json"),
      JSON.stringify({ ...github, prs: [mergedPullRequest(5), mergedPullRequest(8)] }),
    );

    assert.deepEqual((await runMetrics(dir)).finalPRs, known(1));
  });

  test("flags a session whose system prompt is not the arm's", () => {
    const dir = writeRun(join(scratch, "out-live-prompt"), {
      arm: "baseline",
      trial: 1,
      childAddendum: ARM_APPENDIX,
      humanTurns: [],
      resets: 0,
    });

    writeFileSync(join(dir, "harness", "SYSTEM.md"), "A different arm.");

    assert.equal(runIsolation(dir, undefined).ok, false);
  });

  test("reads turns, resets, costs, and root rule breaks from the records, and marks the rest unknown", async () => {
    const { runs } = await gradeDirectory(out);
    const metrics = runs.find((run) => run.trial === 1)?.metrics;

    assert.deepEqual(metrics?.humanTurns, known(3));
    assert.deepEqual(metrics?.reAsks, known(1));
    assert.deepEqual(metrics?.statusRequests, known(1));
    assert.deepEqual(metrics?.t4Resets, known(2));
    assert.deepEqual(metrics?.t4AutoDone, known(2));
    assert.deepEqual(metrics?.rootCost, known(2));
    assert.deepEqual(metrics?.childCost, known(3));
    assert.deepEqual(metrics?.spawns, known(1));
    assert.deepEqual(metrics?.rootLaunches, known(1));
    assert.deepEqual(metrics?.ruleBreaks, known(1));
    assert.equal(metrics?.correct.known, false);
    assert.equal(metrics?.t2CommentLines.known, false);
    assert.equal(metrics?.ledgerAtHead.known, false);
  });
});

describe("the root's rule breaks", () => {
  const scope = { cwd: "/tmp/ic-eval-abc/tally", scratch: "/tmp/ic-eval-abc" };

  function breaksOf(
    calls: readonly { readonly name: string; readonly arguments: Record<string, string> }[],
  ) {
    return ruleBreaks(sessionJsonl({ cwd: scope.cwd, agentDir: "/a", calls }), scope);
  }

  test("writes to the state folder and to scratch paths outside the run are allowed", () => {
    assert.deepEqual(
      breaksOf([
        {
          name: "write",
          arguments: {
            path: "/tmp/ic-eval-abc/home/.local/state/pi-agent/tally/implement-chunk/TAL-1/ledger.tsv",
          },
        },
        { name: "bash", arguments: { command: "echo probe > /tmp/probe.txt" } },
        {
          name: "bash",
          arguments: {
            command:
              "git worktree add --detach /tmp/ic-probe origin/main && git worktree remove --force /tmp/ic-probe",
          },
        },
        {
          name: "bash",
          arguments: {
            command:
              "printf 'PR 2\\tverified: /units -> [ft, km' >> ~/.local/state/pi-agent/tally/ledger.tsv",
          },
        },
        { name: "bash", arguments: { command: "printf 'cut off by codemode: /units > [" } },
        {
          name: "bash",
          arguments: {
            command: "git fetch -q && git merge-base --is-ancestor origin/chunk origin/main",
          },
        },
        {
          name: "bash",
          arguments: {
            command: "cat > /tmp/brief.md <<'EOF'\ngit commit -am 'x' && gh pr merge 3\nEOF",
          },
        },
      ]),
      [],
    );
  });

  test("writes to the repository, its branches, or its PRs are breaks, even when the repository is under /tmp", () => {
    const breaks = breaksOf([
      { name: "edit", arguments: { path: "src/app.mjs" } },
      { name: "bash", arguments: { command: "git -C /tmp/ic-eval-abc/tally push origin HEAD" } },
      { name: "bash", arguments: { command: "gh pr merge 4 --merge" } },
      { name: "bash", arguments: { command: "echo x >> /tmp/ic-eval-abc/tally/CHANGELOG.md" } },
    ]);

    assert.equal(breaks.length, 4, breaks.join("\n"));
  });
});

const none = unknown<number>("not set in this test");

const BLANK: RunMetrics = {
  run: "",
  stop: "",
  correct: unknown("not set in this test"),
  acceptanceFailures: [],
  t1RefusedMerges: none,
  t1RecoverySpawns: none,
  t2CommentLines: none,
  t2FixSpawns: none,
  t3ChangelogCiFailures: none,
  t3ScopeStops: none,
  t3Respawns: none,
  t4AutoDone: none,
  t4Resets: none,
  t4WrongAtMergeReady: none,
  t4WrongAtClose: none,
  t5: unknown("not set in this test"),
  t6ReviewToMergeReadyMinutes: none,
  t6WatcherErrors: none,
  spawns: none,
  spawnsByRole: {},
  rootLaunches: none,
  fixRounds: none,
  respawns: none,
  resumes: none,
  humanTurns: none,
  reAsks: none,
  statusRequests: none,
  wallMinutes: none,
  rootCost: none,
  childCost: none,
  ruleBreaks: none,
  ruleBreakSamples: [],
  ledgerAtHead: unknown("not set in this test"),
  finalPRs: none,
  finalPRsSelfContained: unknown("not set in this test"),
};

function armWith(
  arm: string,
  values: Partial<
    Record<
      | "t1RefusedMerges"
      | "t3Respawns"
      | "t4Resets"
      | "respawns"
      | "humanTurns"
      | "rootCost"
      | "childCost",
      readonly number[]
    >
  >,
  t5: readonly ("caught-before-merge" | "missed")[],
): ArmSummary {
  const runs = Array.from({ length: 3 }, (_, index): GradedRun => {
    const metric = (key: keyof typeof values) => known(values[key]?.[index] ?? 0);

    const metrics: RunMetrics = {
      ...BLANK,
      correct: known(true),
      t1RefusedMerges: metric("t1RefusedMerges"),
      t3Respawns: metric("t3Respawns"),
      t4Resets: metric("t4Resets"),
      respawns: metric("respawns"),
      humanTurns: metric("humanTurns"),
      rootCost: metric("rootCost"),
      childCost: metric("childCost"),
      t5: known(t5[index]),
    };

    return {
      arm,
      trial: index + 1,
      isolation: { ok: true, sessions: 1, bad: [] },
      integrity: { ok: true, problems: [] },
      metrics,
    };
  });

  return summarize(arm, runs);
}

describe("the pre-registered reading", () => {
  const baseline = armWith(
    "baseline",
    {
      t1RefusedMerges: [2, 3, 2],
      t3Respawns: [2, 2, 3],
      t4Resets: [6, 8, 7],
      respawns: [5, 6, 5],
      humanTurns: [4, 5, 4],
      rootCost: [8, 9, 8],
      childCost: [20, 22, 21],
    },
    ["missed", "missed", "missed"],
  );

  test("calls the candidate better when three targets improve beyond spread at no more than 15% extra cost", () => {
    const candidate = armWith(
      "candidate",
      {
        t1RefusedMerges: [0, 0, 1],
        t3Respawns: [0, 1, 0],
        t4Resets: [0, 0, 0],
        respawns: [5, 6, 5],
        humanTurns: [4, 4, 5],
        rootCost: [9, 9, 9],
        childCost: [22, 23, 22],
      },
      ["missed", "missed", "missed"],
    );

    const result = reading(baseline, candidate);

    assert.equal(result.better, true, result.sentence);
    assert.deepEqual(
      result.comparisons
        .filter((comparison) => comparison.verdict === "better")
        .map((comparison) => comparison.name),
      ["T1 refused merges", "T3 scope-stop respawns", "T4 resets"],
    );
  });

  test("does not count a difference whose ranges overlap", () => {
    const candidate = armWith(
      "candidate",
      {
        t1RefusedMerges: [0, 1, 3],
        t3Respawns: [0, 1, 0],
        t4Resets: [0, 0, 0],
        respawns: [5, 6, 5],
        humanTurns: [4, 4, 5],
        rootCost: [8, 9, 8],
        childCost: [20, 22, 21],
      },
      ["missed", "missed", "missed"],
    );

    const result = reading(baseline, candidate);

    assert.equal(result.comparisons[0].verdict, "within spread");
    assert.equal(result.better, false, result.sentence);
  });

  test("rejects a candidate that improves enough but costs more than 15% extra", () => {
    const candidate = armWith(
      "candidate",
      {
        t1RefusedMerges: [0, 0, 0],
        t3Respawns: [0, 0, 0],
        t4Resets: [0, 0, 0],
        respawns: [5, 6, 5],
        humanTurns: [4, 4, 5],
        rootCost: [12, 12, 12],
        childCost: [30, 30, 30],
      },
      ["caught-before-merge", "caught-before-merge", "missed"],
    );

    const result = reading(baseline, candidate);

    assert.equal(
      result.comparisons.find((comparison) => comparison.name === "T5 caught")?.verdict,
      "better",
    );
    assert.equal(result.better, false, result.sentence);
  });
});

describe("trap T3's scope stop", () => {
  test("is a report that stopped because CHANGELOG.md was outside the allowed files", () => {
    assert.equal(
      isChangelogScopeStop(
        "Blocked: CI needs a CHANGELOG.md line, and I stopped because CHANGELOG.md is outside my allowed files.",
      ),
      true,
    );
  });

  test("is not a report that edited the changelog or names something else out of scope", () => {
    assert.equal(
      isChangelogScopeStop(
        "Added a CHANGELOG.md line under Unreleased.\n\nI kept the name `rawPrecision`, since renaming it was out of scope.",
      ),
      false,
    );
  });
});
