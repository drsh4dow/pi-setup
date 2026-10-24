import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSession } from "../../lib/session.ts";
import { gradeDirectory, report, validity, type GradedRun } from "../grade.ts";
import { parseAnswer } from "../judge.ts";
import type { RunRecord } from "../record.ts";
import { scenarioById, type ScenarioId } from "../scenarios.ts";
import { preparedScratch, scratchRepo, stubJudge, temporary } from "./support.ts";

const ARM_ROOT = "/home/dev/.pi/.worktrees/candidate-arm";

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    scenario: "restate-plan-offer",
    arm: "candidate",
    armRoot: ARM_ROOT,
    armHead: "0000000",
    model: "anthropic/claude-opus-5-5",
    thinking: "high",
    trial: 1,
    workdir: "/tmp/none",
    setupProblems: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1000,
    session: "session.jsonl",
    ...overrides,
  };
}

function jsonl(text: string, stopReason = "stop") {
  return [
    { type: "session", cwd: "/tmp/none" },
    {
      type: "message",
      message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
}

const scenario = (id: ScenarioId) => scenarioById(id);

test("a run that exited 0 and ended its turn is valid", () => {
  assert.deepEqual(
    validity(record(), parseSession(jsonl("done")), scenario("restate-plan-offer")),
    {
      kind: "valid",
      note: null,
    },
  );
});

test("timeouts, non-zero exits, missing sessions, other stop reasons, and failed setup are invalid", () => {
  const ended = parseSession(jsonl("done"));

  const cases: [RunRecord, ReturnType<typeof parseSession> | undefined, RegExp][] = [
    [record({ timedOut: true, exitCode: null, signal: "SIGKILL" }), ended, /timed out/],
    [record({ exitCode: 1 }), ended, /exit 1/],
    [record({ session: null }), undefined, /no session/],
    [record(), parseSession(jsonl("cut", "length")), /stop reason length/],
    [record(), parseSession(jsonl("", "error")), /stop reason error/],
    [record({ setupProblems: ["HEAD is on feature: refs/heads/main"] }), ended, /setup failed/],
  ];

  for (const [run, session, reason] of cases) {
    const result = validity(run, session, scenario("restate-plan-offer"));

    assert.equal(result.kind, "invalid");
    assert.match(result.kind === "invalid" ? result.reason : "", reason);
  }
});

test("a cosmetic-wake run that timed out waiting on its watcher after ending its turn is valid", () => {
  const timedOut = record({
    scenario: "cosmetic-wake",
    timedOut: true,
    exitCode: null,
    signal: "SIGKILL",
  });

  assert.equal(
    validity(timedOut, parseSession(jsonl("acknowledged")), scenario("cosmetic-wake")).kind,
    "valid",
  );
  assert.equal(
    validity(timedOut, parseSession(jsonl("", "toolUse")), scenario("cosmetic-wake")).kind,
    "invalid",
  );
});

const REPLY = `Sharpened: post the notes from ${ARM_ROOT} to chat.\n\n1. Which chat? I recommend #releases.\n\nShall I present the full executable plan?`;

function runDirectory(overrides: Partial<RunRecord> = {}, text = REPLY): string {
  const workdir = scratchRepo({ "a.md": "a\n" });
  const dir = temporary(mkdtempSync(join(tmpdir(), "grade-run-")));
  const where = preparedScratch("restate-plan-offer", workdir);

  writeFileSync(join(dir, "run.json"), JSON.stringify(record({ workdir, ...overrides })));
  writeFileSync(join(dir, "setup.json"), JSON.stringify(where.setup));
  writeFileSync(join(dir, "session.jsonl"), jsonl(text));

  return dir;
}

test("grading keeps the final text, caches judge answers, and hides the arm's root from the judge", async () => {
  const dir = runDirectory();
  const first = stubJudge(true);
  const graded = await gradeDirectory(dir, "judge-model", first.judge);

  assert.equal(graded.primary, "pass");
  assert.equal(graded.finalText, REPLY);
  assert.equal(first.requests.length, 1);
  assert.doesNotMatch(first.requests[0]?.finalText ?? "", /candidate-arm/);
  assert.ok(existsSync(join(dir, "judge.json")));

  const second = stubJudge(false);
  const regraded = await gradeDirectory(dir, "judge-model", second.judge);

  assert.equal(second.requests.length, 0);
  assert.equal(regraded.primary, "pass");
});

test("a judge that could not run leaves its metric and the primary undecided, and is asked again next time", async () => {
  const dir = runDirectory();
  const down = stubJudge("unavailable");
  const graded = await gradeDirectory(dir, "judge-model", down.judge);

  assert.equal(graded.metrics.offersFullPlan?.kind, "unknown");
  assert.equal(graded.primary, "unknown");
  assert.equal(existsSync(join(dir, "judge.json")), false);

  const up = stubJudge(true);

  await gradeDirectory(dir, "judge-model", up.judge);
  assert.equal(up.requests.length, 1);
});

test("an invalid run is graded without asking the judge", async () => {
  const judge = stubJudge(true);
  const graded = await gradeDirectory(runDirectory({ exitCode: 2 }), "judge-model", judge.judge);

  assert.equal(graded.validity.kind, "invalid");
  assert.equal(judge.requests.length, 0);
});

test("judge replies parse from a JSON line, even wrapped, and anything else is unavailable", () => {
  assert.deepEqual(parseAnswer('```json\n{"pass": true, "why": "it offers"}\n```'), {
    kind: "answered",
    pass: true,
    why: "it offers",
  });
  assert.equal(parseAnswer("I think yes").kind, "unavailable");
  assert.equal(parseAnswer('{"pass": "yes"}').kind, "unavailable");
});

function gradedRun(arm: string, primary: GradedRun["primary"], valid = true): GradedRun {
  return {
    dir: `/r/${arm}`,
    run: record({ arm }),
    validity: valid ? { kind: "valid", note: null } : { kind: "invalid", reason: "timed out" },
    primary,
    metrics: valid
      ? { offersFullPlan: { kind: "flag", value: primary === "pass", evidence: "" } }
      : {},
    disagreements: [],
    finalText: "",
    judgeAnswers: null,
  };
}

test("the report gives valid runs over total, the primary rate over decided runs, and each metric per arm", () => {
  const markdown = report([
    gradedRun("baseline", "fail"),
    gradedRun("baseline", "unknown"),
    gradedRun("candidate", "pass"),
    gradedRun("candidate", "pass", false),
  ]);

  assert.match(markdown, /\| baseline \| 2\/2 \| 0\/1 \(\+1\?\) \| 0\/2 \|/);
  assert.match(markdown, /\| candidate \| 1\/2 \| 1\/1 \| 1\/1 \|/);
  assert.match(markdown, /## Invalid runs\n\n- restate-plan-offer candidate .* timed out/);
});
