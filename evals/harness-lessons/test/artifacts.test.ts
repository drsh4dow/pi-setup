import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  adaptOutsideSkill,
  boundedRecheck,
  crossProject,
  dependencyByPath,
  VERBATIM_PROBES,
} from "../grade-artifacts.ts";
import type { Metric } from "../metrics.ts";
import type { ScenarioId } from "../scenarios.ts";
import {
  commitAll,
  git,
  input,
  preparedScratch,
  scratchRepo,
  session,
  stubJudge,
  writeFiles,
} from "./support.ts";

const HARNESS = {
  "AGENTS.md": "# pi-setup\n\nRun `vp run verify` before reporting.\n",
  "agent/skills/unslop/SKILL.md": "---\nname: unslop\n---\n\n# Unslop\n",
};

function values(metrics: Readonly<Record<string, Metric>>) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, metric]) => [
      name,
      metric.kind === "unknown" ? "unknown" : metric.value,
    ]),
  );
}

/** A harness clone where the run left `files` in the working tree. */
function harnessWith(id: ScenarioId, files: Readonly<Record<string, string>>) {
  const root = scratchRepo(HARNESS);
  const where = preparedScratch(id, root);

  writeFiles(root, files);

  return where;
}

test("cross-project passes a skill that finds the project's checks and names vp only as an example", async () => {
  const skill = `---\nname: pre-commit-checks\n---\n\nFind the check command in the project's AGENTS.md, package.json scripts, Makefile, or CI workflow, for example \`vp run verify\` here or \`make check\` elsewhere. Run it before committing.\n`;
  const where = harnessWith("cross-project", { "agent/skills/pre-commit-checks/SKILL.md": skill });
  const judge = stubJudge(true);
  const graded = await crossProject(input("cross-project", where, session([], "Added."), judge));

  assert.deepEqual(values(graded.metrics), {
    produced: true,
    hardcodesVp: false,
    discoversPerProject: true,
  });
  assert.equal(graded.primary, "pass");
  assert.match(judge.requests[0]?.artifacts[0]?.text ?? "", /package\.json/);
});

test("cross-project fails a skill that hardcodes vp run verify", async () => {
  const skill = `---\nname: pre-commit-checks\n---\n\nBefore every commit, run:\n\n\`\`\`bash\nvp run verify\n\`\`\`\n`;
  const where = harnessWith("cross-project", { "agent/skills/pre-commit-checks/SKILL.md": skill });

  const graded = await crossProject(
    input("cross-project", where, session([], "Added."), stubJudge(false)),
  );

  assert.deepEqual(values(graded.metrics), {
    produced: true,
    hardcodesVp: true,
    discoversPerProject: false,
  });
  assert.equal(graded.primary, "fail");
});

test("cross-project fails, with its metrics undecided, when no skill was produced", async () => {
  const where = harnessWith("cross-project", {});
  const graded = await crossProject(input("cross-project", where, session([], "I could not.")));

  assert.deepEqual(values(graded.metrics), {
    produced: false,
    hardcodesVp: "unknown",
    discoversPerProject: "unknown",
  });
  assert.equal(graded.primary, "fail");
});

const OUTSIDE = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "changelog-skill", "SKILL.md"),
  "utf8",
);

test("adapt-outside-skill passes a skill without the pin, label, or personal path that keeps every probe", async () => {
  const adapted = `---\nname: writing-changelogs\ndescription: Write changelog entries.\n---\n\n# Writing changelogs\n\n- **Write each entry** for the person upgrading, not for the person who wrote the code.\n- When a change breaks existing behavior, say what the reader must do before they upgrade.\n- The reviewer, not the author, decides whether an entry is user-facing.\n`;

  const where = harnessWith("adapt-outside-skill", {
    "agent/skills/writing-changelogs/SKILL.md": adapted,
  });

  const graded = await adaptOutsideSkill(
    input("adapt-outside-skill", where, session([], "Adapted.")),
  );

  assert.deepEqual(values(graded.metrics), {
    produced: true,
    noPin: true,
    noLabel: true,
    noPersonalPath: true,
    verbatimKept: VERBATIM_PROBES.length,
    verbatimAll: true,
    scopeKept: true,
  });
  assert.equal(graded.primary, "pass");
});

test("adapt-outside-skill fails the outside skill copied as is, with its probes paraphrased", async () => {
  const copied = OUTSIDE.replace(VERBATIM_PROBES[0] ?? "", "Write entries for upgraders.");

  const where = harnessWith("adapt-outside-skill", {
    "agent/skills/writing-changelogs/SKILL.md": copied,
  });

  const graded = await adaptOutsideSkill(
    input("adapt-outside-skill", where, session([], "Copied."), stubJudge(false)),
  );

  assert.deepEqual(values(graded.metrics), {
    produced: true,
    noPin: false,
    noLabel: false,
    noPersonalPath: false,
    verbatimKept: VERBATIM_PROBES.length - 1,
    verbatimAll: false,
    scopeKept: false,
  });
  assert.equal(graded.primary, "fail");
});

test("adapt-outside-skill grades the skill on a branch when the run committed it there", async () => {
  const root = scratchRepo(HARNESS);
  const where = preparedScratch("adapt-outside-skill", root);

  git(root, "checkout", "-q", "-b", "writing-changelogs");
  writeFiles(root, { "agent/skills/writing-changelogs/SKILL.md": "# Writing changelogs\n" });
  commitAll(root, "Add writing-changelogs");
  git(root, "checkout", "-q", "main");

  const graded = await adaptOutsideSkill(
    input("adapt-outside-skill", where, session([], "On a branch.")),
  );

  assert.equal(values(graded.metrics).produced, true);
});

test("bounded-recheck passes a review step with a pass count and fails one without", async () => {
  const bounded = harnessWith("bounded-recheck", {
    "agent/prompts/release-notes.md":
      "Draft the notes. Review the draft once for gaps and fix them.\n",
  });

  const open = harnessWith("bounded-recheck", {
    "agent/prompts/release-notes.md":
      "Draft the notes. Review the draft for gaps and fix them until it is good.\n",
  });

  const pass = await boundedRecheck(
    input("bounded-recheck", bounded, session([], "Written."), stubJudge(true)),
  );

  const fail = await boundedRecheck(
    input("bounded-recheck", open, session([], "Written."), stubJudge(false)),
  );

  assert.deepEqual([values(pass.metrics).boundedLoop, pass.primary], [true, "pass"]);
  assert.deepEqual([values(fail.metrics).boundedLoop, fail.primary], [false, "fail"]);
  assert.deepEqual([pass.crossChecks[0]?.signal, fail.crossChecks[0]?.signal], [true, false]);
});

test("dependency-by-path passes a relative link to unslop that resolves", async () => {
  const where = harnessWith("dependency-by-path", {
    "agent/skills/writing-release-notes/SKILL.md":
      "Last, run [unslop](../unslop/SKILL.md) over the prose.\n",
  });

  const graded = await dependencyByPath(
    input("dependency-by-path", where, session([], "Written.")),
  );

  assert.deepEqual(values(graded.metrics), { produced: true, pathLink: true });
  assert.equal(graded.primary, "pass");
});

test("dependency-by-path fails a skill that names unslop without a path, or by a path that does not resolve", async () => {
  const byName = harnessWith("dependency-by-path", {
    "agent/skills/writing-release-notes/SKILL.md": "Last, run the unslop skill over the prose.\n",
  });

  const broken = harnessWith("dependency-by-path", {
    "agent/skills/writing-release-notes/SKILL.md":
      "Last, read ../../unslop/SKILL.md and apply it.\n",
  });

  const graded = await Promise.all(
    [byName, broken].map((where) =>
      dependencyByPath(input("dependency-by-path", where, session([], "Written."))),
    ),
  );

  for (const result of graded) {
    assert.deepEqual(values(result.metrics), { produced: true, pathLink: false });
  }
});
