import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { harnessArgs, selectScenarios } from "../run.ts";
import { scenarioById, scenarios } from "../scenarios.ts";
import { keepStateFolder, keptStateFolder } from "../state-folder.ts";
import { temporary, writeFiles } from "./support.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The directories passed to `--skill`, in order. */
function skillPaths(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => (args[index - 1] === "--skill" ? [arg] : []));
}

test("a clone run loads the arm's skills and the clone's own project skills", () => {
  const args = harnessArgs({
    scenario: scenarioById("skill-tuning-method"),
    armRoot: ROOT,
    workdir: "/tmp/pi-setup-abc",
  });

  assert.ok(args.includes("--no-skills"));
  assert.deepEqual(skillPaths(args), [
    join(ROOT, "agent", "skills"),
    "/tmp/pi-setup-abc/.agents/skills",
  ]);
});

test("a fixture run loads only the arm's skills", () => {
  const args = harnessArgs({
    scenario: scenarioById("hand-edits-use-edit"),
    armRoot: ROOT,
    workdir: "/tmp/fixture-abc",
  });

  assert.deepEqual(skillPaths(args), [join(ROOT, "agent", "skills")]);
});

const ids = (only?: string[]) => selectScenarios(only).map((scenario) => scenario.id);

test("a scenario off by default runs only when --only names it", () => {
  const off = scenarios.filter((scenario) => !ids().includes(scenario.id));

  assert.deepEqual(
    off.map((scenario) => scenario.id),
    ["cosmetic-wake", "catchup-video-recorded"],
  );
  assert.deepEqual(ids(["catchup-video-recorded", "cosmetic-wake", "cross-project"]), [
    "cross-project",
    "cosmetic-wake",
    "catchup-video-recorded",
  ]);
});

test("keeping a run's state folder moves it into the output directory over an earlier copy", () => {
  const live = join(temporary(mkdtempSync(join(tmpdir(), "state-"))), "gift-registry");
  const outputDir = temporary(mkdtempSync(join(tmpdir(), "run-out-")));

  writeFiles(live, { "catchup-video/catchup.mp4": "video" });
  writeFiles(keptStateFolder(outputDir), { "stale.txt": "an earlier attempt" });
  keepStateFolder({ live, outputDir });

  assert.ok(!existsSync(live));
  assert.deepEqual(readdirSync(keptStateFolder(outputDir)), ["catchup-video"]);
  assert.equal(
    readFileSync(join(keptStateFolder(outputDir), "catchup-video", "catchup.mp4"), "utf8"),
    "video",
  );
});

test("a run that wrote no state folder keeps an empty copy", () => {
  const live = join(temporary(mkdtempSync(join(tmpdir(), "state-"))), "gift-registry");
  const outputDir = temporary(mkdtempSync(join(tmpdir(), "run-out-")));

  keepStateFolder({ live, outputDir });

  assert.deepEqual(readdirSync(keptStateFolder(outputDir)), []);
});
