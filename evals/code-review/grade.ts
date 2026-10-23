#!/usr/bin/env node
// Grades review runs against each fixture's planted defects. A judge model reads only the final
// review and the defect list, and decides per defect whether the review reports it and how it
// classes it. Verdicts are cached in judge.json beside each run, so regrading is free; delete the
// file to rejudge a run. Read a sample of reviews beside their verdicts before trusting a number.
//
//   node evals/code-review/grade.ts <results-dir> [--judge anthropic/claude-opus-5-5]

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { candidateEnv, writeAtomically } from "../lib/pi-run.ts";
import { loadFixtures, type Defect, type Lens } from "./scenarios.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

export const ReviewRunRecord = Schema.Struct({
  fixture: Schema.String,
  // A string rather than the current arms, so runs from retired arms still grade.
  arm: Schema.String,
  model: Schema.String,
  trial: Schema.Int,
  workdir: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  durationMs: Schema.Int,
  session: Schema.NullOr(Schema.String),
});

export type ReviewRunRecord = typeof ReviewRunRecord.Type;

const Verdict = Schema.Literals(["blocking", "advisory", "dismissed", "missed"]);

export const Judgement = Schema.Struct({
  defects: Schema.Array(
    Schema.Struct({ id: Schema.String, verdict: Verdict, evidence: Schema.String }),
  ),
  otherBlocking: Schema.Int,
});

export type Judgement = typeof Judgement.Type;

const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(ReviewRunRecord));

const decodeJudgement = Schema.decodeUnknownSync(Schema.fromJsonString(Judgement));

/**
 * Names what keeps a judgement from scoring every defect exactly once: a defect with no verdict,
 * a defect judged twice, or a verdict for an id the fixture does not plant. Empty when it is whole.
 */
export function judgementProblems(defects: readonly Defect[], judgement: Judgement): string[] {
  const known = new Set(defects.map((defect) => defect.id));
  const seen = new Map<string, number>();

  for (const { id } of judgement.defects) seen.set(id, (seen.get(id) ?? 0) + 1);

  return [
    ...[...known].flatMap((id) => (seen.has(id) ? [] : [`no verdict for ${id}`])),
    ...[...seen].flatMap(([id, count]) => {
      if (!known.has(id)) return [`verdict for unknown ${id}`];

      return count > 1 ? [`${count} verdicts for ${id}`] : [];
    }),
  ];
}

export function judgePrompt(defects: readonly Defect[], review: string): string {
  const list = defects.map(({ id, file, lines, summary }) => ({ id, file, lines, summary }));

  return `You grade a code review against a list of known defects in the change it reviewed. Judge only from the review text below. Do not judge the code.

For each defect, decide whether the review reports it: the review names the same problem at the same place (the same file and nearby lines, or the same function), even in other words. A review that mentions the area but describes a different problem has not reported it. Give one verdict per defect:

- "blocking": reported as must-fix, such as Act on, critical, blocker, must address, or request changes.
- "advisory": reported as worth doing but optional, such as Consider, warning, should, suggestion, nit, or noted.
- "dismissed": raised, then dismissed or judged not a problem.
- "missed": not reported.

Then count "otherBlocking": findings the review reports as must-fix that match none of the defects.

Defects:
${JSON.stringify(list, null, 2)}

Review:
<<<REVIEW
${review}
REVIEW>>>

Reply with only this JSON and nothing else:
{"defects":[{"id":"<id>","verdict":"blocking|advisory|dismissed|missed","evidence":"<a short quote from the review, or empty>"}],"otherBlocking":<integer>}`;
}

/** The JSON object in a reply that may wrap it in prose or a code fence. */
export function extractJson(reply: string): string {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");

  if (start === -1 || end < start) throw new Error(`no JSON object in judge reply: ${reply}`);

  return reply.slice(start, end + 1);
}

function judge(model: string, defects: readonly Defect[], review: string): Judgement {
  const reply = execFileSync(
    "pi",
    [
      "-p",
      "--no-session",
      "--no-tools",
      "--no-skills",
      "--no-extensions",
      "--no-mcp",
      "--no-context-files",
      "--no-prompt-templates",
      "--model",
      model,
      "--thinking",
      "medium",
      judgePrompt(defects, review),
    ],
    { encoding: "utf8", env: candidateEnv(), maxBuffer: 16 * 1024 * 1024 },
  );

  return decodeJudgement(extractJson(reply));
}

/** Lenses whose defects should block a merge. The rest are judgment calls, where advisory is right. */
const CONSEQUENTIAL: ReadonlySet<Lens> = new Set([
  "spec-fidelity",
  "standards",
  "logical-proof",
  "security",
  "tests",
]);

interface Tally {
  caught: number;
  blocking: number;
  total: number;
}

const tally = (): Tally => ({ caught: 0, blocking: 0, total: 0 });

function percent(part: number, whole: number): string {
  return whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { judge: { type: "string", default: "anthropic/claude-opus-5-5" } },
  });

  const resultsDir = positionals[0];

  if (!resultsDir) {
    console.error("usage: node evals/code-review/grade.ts <results-dir> [--judge <model>]");
    process.exit(2);
  }

  const fixtures = new Map(loadFixtures(HERE).map((fixture) => [fixture.name, fixture.truth]));
  const byArm = new Map<string, Tally>();
  const byArmWeight = new Map<string, Tally>();
  const byArmLens = new Map<string, Tally>();
  const noise = new Map<string, { runs: number; otherBlocking: number }>();
  let invalid = 0;

  const runs = readdirSync(resultsDir, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith("run.json"))
    .toSorted();

  for (const path of runs) {
    const dir = join(resultsDir, dirname(path));
    const record = decodeRecord(readFileSync(join(dir, "run.json"), "utf8"));
    const truth = fixtures.get(record.fixture);
    const review = readFileSync(join(dir, "stdout.txt"), "utf8").trim();

    if (!truth || record.exitCode !== 0 || record.timedOut || review === "") {
      invalid += 1;
      console.log(`invalid: ${dir}`);
      continue;
    }

    const cache = join(dir, "judge.json");

    const judgement = existsSync(cache)
      ? decodeJudgement(readFileSync(cache, "utf8"))
      : judge(values.judge, truth.defects, review);

    const problems = judgementProblems(truth.defects, judgement);

    if (problems.length > 0) {
      invalid += 1;
      console.log(`invalid judgement: ${dir} (${problems.join("; ")})`);
      continue;
    }

    writeAtomically(cache, `${JSON.stringify(judgement, null, 2)}\n`);

    const lensOf = new Map<string, Lens>(truth.defects.map((defect) => [defect.id, defect.lens]));
    const armTally = byArm.get(record.arm) ?? tally();

    for (const { id, verdict } of judgement.defects) {
      const lens = lensOf.get(id);

      if (lens === undefined) throw new Error(`judgement for unknown defect ${id} slipped through`);

      const key = `${record.arm}\t${lens}`;
      const lensTally = byArmLens.get(key) ?? tally();
      const weightKey = `${record.arm}\t${CONSEQUENTIAL.has(lens) ? "consequential" : "judgment"}`;
      const weightTally = byArmWeight.get(weightKey) ?? tally();

      for (const counter of [armTally, lensTally, weightTally]) {
        counter.total += 1;

        if (verdict === "blocking" || verdict === "advisory") counter.caught += 1;

        if (verdict === "blocking") counter.blocking += 1;
      }

      byArmLens.set(key, lensTally);
      byArmWeight.set(weightKey, weightTally);
    }

    byArm.set(record.arm, armTally);

    if (truth.defects.length === 0) {
      const armNoise = noise.get(record.arm) ?? { runs: 0, otherBlocking: 0 };

      armNoise.runs += 1;
      armNoise.otherBlocking += judgement.otherBlocking;
      noise.set(record.arm, armNoise);
    }
  }

  console.log("\narm\tcaught\tas blocking\tdefects");

  for (const [arm, { caught, blocking, total }] of byArm) {
    console.log(`${arm}\t${percent(caught, total)}\t${percent(blocking, total)}\t${total}`);
  }

  console.log("\narm\tlenses\tcaught\tas blocking\tdefects");

  for (const [key, { caught, blocking, total }] of [...byArmWeight].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(`${key}\t${percent(caught, total)}\t${percent(blocking, total)}\t${total}`);
  }

  console.log("\narm\tlens\tcaught\tdefects");

  for (const [key, { caught, total }] of [...byArmLens].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    console.log(`${key}\t${percent(caught, total)}\t${total}`);
  }

  console.log("\narm\tblocking findings per clean-control run");

  for (const [arm, { runs: count, otherBlocking }] of noise) {
    console.log(`${arm}\t${(otherBlocking / count).toFixed(1)}\t(${count} runs)`);
  }

  console.log(`\n${runs.length} runs, ${invalid} invalid`);
}

if (import.meta.main) main();
