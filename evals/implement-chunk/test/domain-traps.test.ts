// Traps T7, T8, and T9 and the edge cases on synthetic archived origins: a careful chunk passes
// each, a naive one fails each, and a run on the fixture from before the domain traps reads as
// unknown. Every value comes from the final `main` of the origin and the run's records.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { EDGE_CASES, runAcceptance } from "../acceptance.ts";
import { buildCommit, serve, stopProcess, waitForVersion } from "../deploy.ts";
import { runMetrics, type RunMetrics } from "../metrics.ts";
import { withOriginAsync } from "../origin.ts";
import { freePort } from "../world.ts";
import { ARM_APPENDIX, writeOrigin, writeRun, type RunSpec } from "./run-dir.ts";
import { CAREFUL, NAIVE } from "./tally-chunks.ts";

const scratch = mkdtempSync(join(tmpdir(), "ic-domain-traps-test-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

let trial = 0;

async function graded(
  files: Readonly<Record<string, string>>,
  {
    spec = {},
    withoutGlossary = false,
    decisions,
  }: { spec?: Partial<RunSpec>; withoutGlossary?: boolean; decisions?: string } = {},
): Promise<RunMetrics> {
  trial += 1;

  const dir = writeRun(join(scratch, "out"), {
    arm: "arm",
    trial,
    childAddendum: ARM_APPENDIX,
    humanTurns: ["intake"],
    resets: 0,
    ...spec,
  });

  writeOrigin(dir, { files, withoutGlossary });

  if (decisions !== undefined) {
    mkdirSync(join(dir, "state", "tally", "implement-chunk", "TAL-1"), { recursive: true });
    writeFileSync(
      join(dir, "state", "tally", "implement-chunk", "TAL-1", "decisions.md"),
      decisions,
    );
  }

  return runMetrics(dir);
}

describe("the domain traps", () => {
  test("the careful chunk passes every ticket criterion and every edge case on a real build", async () => {
    const dir = join(scratch, "build-check");

    mkdirSync(dir, { recursive: true });
    writeOrigin(dir, { files: CAREFUL });

    const failures = await withOriginAsync(dir, async (bare) => {
      const build = buildCommit({ bare, commit: "main", dir: join(dir, "build") });
      const port = await freePort();
      const server = serve({ tree: build.tree, port, logFile: join(dir, "server.log") });

      try {
        await waitForVersion(port, "main", 10_000);

        const outcomes = [
          ...(await runAcceptance(`http://127.0.0.1:${port}`)),
          ...(await runAcceptance(`http://127.0.0.1:${port}`, EDGE_CASES)),
        ];

        return outcomes.filter((outcome) => !outcome.ok);
      } finally {
        stopProcess(server);
      }
    });

    assert.deepEqual(failures, []);
  });

  test("T7: the careful chunk adheres to the glossary, and the naive one drifts, line by line", async () => {
    const careful = await graded(CAREFUL);
    const naive = await graded(NAIVE);

    assert.deepEqual(careful.t7, { known: true, value: "adheres" });
    assert.deepEqual(careful.t7AvoidedTerms, { known: true, value: 0 });
    assert.deepEqual(naive.t7, { known: true, value: "drifted" });
    // Five lines name the precision "decimals", three the symbol "abbreviation", and one test.
    assert.deepEqual(naive.t7AvoidedTerms, { known: true, value: 9 });
    assert.equal(naive.t7Samples[0], "src/app.mjs: const MAX_DECIMALS = 6; [decimals]");
  });

  test("T8: conforming to the ADR, naming it to the user or in decisions.md, or missing it", async () => {
    assert.deepEqual((await graded(CAREFUL)).t8, { known: true, value: "conforms" });
    assert.deepEqual((await graded(NAIVE)).t8, { known: true, value: "missed" });

    const told = await graded(NAIVE, {
      spec: { rootTexts: ["TAL-2 converts negative values, which contradicts ADR-0001. Proceed?"] },
    });

    assert.deepEqual(told.t8, { known: true, value: "surfaced" });

    const recorded = await graded(NAIVE, {
      decisions: "- Kept negative values: docs/adr/0001-lengths-are-never-negative.md is stale.\n",
    });

    assert.deepEqual(recorded.t8, { known: true, value: "surfaced" });
  });

  test("T9: both new errors come from glossary-named catalogue entries, or the reason they do not", async () => {
    const careful = await graded(CAREFUL);
    const naive = await graded(NAIVE);

    assert.deepEqual(careful.t9, {
      known: true,
      value: { outcome: "consistent", ids: ["TAL-3 unknown-symbol", "TAL-4 invalid-precision"] },
    });
    assert.deepEqual(naive.t9, {
      known: true,
      value: {
        outcome: "inconsistent",
        why: `TAL-3's error "unknown abbreviation parsec" is in no catalogue entry`,
      },
    });
  });

  test("T9: a catalogue entry that names a glossary term beside an avoided one is inconsistent", async () => {
    const run = await graded({
      ...CAREFUL,
      "src/messages.mjs": CAREFUL["src/messages.mjs"].replace(
        '"invalid-precision"',
        '"precision-decimal-places"',
      ),
      "src/app.mjs": CAREFUL["src/app.mjs"].replace(
        '"invalid-precision"',
        '"precision-decimal-places"',
      ),
    });

    assert.equal(run.t9.known && run.t9.value.outcome, "inconsistent");
  });

  test("T9: counts git's conflict reports in tool results and the children that resolve one", async () => {
    const run = await graded(CAREFUL, {
      spec: {
        childCalls: [
          {
            name: "bash",
            arguments: { command: "git merge origin/b4" },
            output: "CONFLICT (content): Merge conflict in src/messages.mjs",
          },
        ],
      },
    });

    assert.deepEqual(run.t9MergeConflicts, { known: true, value: 1 });
    assert.deepEqual((await graded(CAREFUL)).t9MergeConflicts, { known: true, value: 0 });
  });

  test("edge cases: the careful chunk passes all of them, and the naive one fails some", async () => {
    const careful = await graded(CAREFUL);
    const naive = await graded(NAIVE);

    assert.deepEqual(careful.edgeCases, {
      known: true,
      value: { passed: EDGE_CASES.length, total: EDGE_CASES.length },
    });
    assert.ok(naive.edgeCases.known);
    assert.ok(naive.edgeCases.value.passed < naive.edgeCases.value.total);
    assert.ok(
      naive.edgeCaseFailures.some((failure) => failure.includes("value=-1")),
      naive.edgeCaseFailures.join("\n"),
    );
  });

  test("a run on the fixture from before the domain traps reads every domain trap as unknown", async () => {
    const run = await graded(CAREFUL, { withoutGlossary: true });

    for (const value of [run.t7, run.t8, run.t9, run.edgeCases]) {
      assert.deepEqual(value, {
        known: false,
        reason: "the run's fixture predates the domain traps: no GLOSSARY.md",
      });
    }
  });
});
