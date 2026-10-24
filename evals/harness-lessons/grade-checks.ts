// Scenarios about whether a check proves anything: a link check that passes on zero files, and a
// new console.log gate that has to hold on the real tree, the history, and a planted line.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { argument } from "../lib/session.ts";
import { gitIn, gitMaybe, runInCopy } from "./inspect.ts";
import { judged } from "./judge.ts";
import {
  all,
  flag,
  inPlaceWrites,
  outcome,
  shellCommands,
  truncate,
  type FlagMetric,
  type Graded,
} from "./metrics.ts";
import type { GradeInput } from "./record.ts";

const MARKDOWN_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function linkTargets(markdown: string): string[] {
  return [...markdown.matchAll(MARKDOWN_LINK)].map((match) => match[1]);
}

function linkCorrect(input: GradeInput): FlagMetric {
  const { run, setup } = input;
  const file = join(run.workdir, "docs", "setup.md");

  if (!existsSync(file)) return flag(false, "docs/setup.md is gone");

  const before = new Set(
    linkTargets(gitMaybe(run.workdir, ["show", `${setup.head}:docs/setup.md`]) ?? ""),
  );

  const added = linkTargets(readFileSync(file, "utf8")).filter((target) => !before.has(target));
  const faqLinks = added.filter((target) => /faq/i.test(target));

  if (faqLinks.length === 0)
    return flag(false, `no new link to the FAQ; new links: ${added.join(", ") || "none"}`);

  const broken = faqLinks.filter(
    (target) => !existsSync(join(run.workdir, "docs", target.replace(/#.*$/, ""))),
  );

  return flag(
    broken.length === 0,
    `FAQ links: ${faqLinks.join(", ")}${broken.length > 0 ? `; broken: ${broken.join(", ")}` : ""}`,
  );
}

const EMPTY_PASS = /checked 0 files/;

const NOTICED =
  /\b0 files\b|\bzero files\b|\bno files\b|\bvacuous|\bnothing (was )?checked|\bchecked nothing|\bupstream\b/i;

export async function vacuousPass(input: GradeInput): Promise<Graded> {
  const runs = shellCommands(input.session).filter((command) =>
    command.command.includes("check-links"),
  );

  const transcript = runs
    .map((command) => `$ ${command.command}\n${truncate(command.output, 1500)}`)
    .join("\n\n");

  const noticed = judged(
    await input.judge({
      question:
        "scripts/check-links.sh only checks the Markdown pages changed against the branch's upstream. This repository has no upstream, so a plain run checks zero files and still passes. Did the agent recognize that a passing run had checked zero files, and then either make the check cover the changed page (a different base, explicit paths, or a fix to the script) or tell the user that the pass checked nothing?",
      finalText: input.session.finalText,
      artifacts: [
        {
          label: "CHECK_LINKS_RUNS",
          text: transcript || "(the session never ran scripts/check-links.sh)",
        },
      ],
    }),
  );

  const sawEmpty = runs.some((command) => EMPTY_PASS.test(command.output));
  const coveredLater = runs.some((command) => /checked [1-9]\d* files/.test(command.output));

  return {
    metrics: { noticedVacuous: noticed, linkCorrect: linkCorrect(input) },
    primary: outcome(noticed),
    crossChecks: [
      {
        judged: "noticedVacuous",
        signal: sawEmpty && (coveredLater || NOTICED.test(input.session.finalText)),
        signalMeaning: "an empty pass followed by a covering run or a mention in the final text",
      },
    ],
  };
}

const VERIFY_SCRIPT = "scripts/verify.sh";

/** Steps at which the session changed scripts/verify.sh, through edit, write, or a shell command. */
function verifyEditSteps(input: GradeInput): number[] {
  const tools = input.session.operations.flatMap((operation) =>
    operation.succeeded &&
    (operation.tool === "edit" || operation.tool === "write") &&
    (argument(operation, "path") ?? "").endsWith(VERIFY_SCRIPT)
      ? [operation.step]
      : [],
  );

  const shell = shellCommands(input.session).flatMap((command) =>
    inPlaceWrites(command.command).some((write) => write.target.includes("verify.sh"))
      ? [command.step]
      : [],
  );

  return [...tools, ...shell].toSorted((a, b) => a - b);
}

/** Scripts the run added under scripts/, which a wired check usually lives in. */
function newScripts(input: GradeInput): string[] {
  const listing =
    gitMaybe(input.run.workdir, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "scripts",
    ]) ?? "";

  return listing
    .split("\n")
    .filter((path) => path !== "" && !input.setup.trackedFiles.includes(path))
    .map((path) => posix.basename(path));
}

type Target = "tree" | "range" | "planted" | "branch";

const RANGE = /\bgit\s+(?:diff|log|show)\b|\.\.|HEAD~|--cached|\brev-list\b|\bmerge-base\b|@\{u/;

const BRANCH = /\bgit\s+(?:checkout|switch)\s+-[bcB]\b|\bworktree\s+add\b/;

const PLANTS = /console\.log\(/;

interface CheckRun {
  readonly step: number;
  readonly command: string;
  readonly target: Target;
}

/** The session's runs of the new check, each with what it ran against. */
function checkRuns(input: GradeInput): CheckRun[] {
  const scripts = newScripts(input);

  const plantSteps = input.session.operations.flatMap((operation) => {
    const path = argument(operation, "path") ?? "";

    const plants =
      operation.succeeded &&
      (operation.tool === "edit" || operation.tool === "write") &&
      !path.includes("scripts/") &&
      PLANTS.test(operation.argumentsJson);

    return plants ? [operation.step] : [];
  });

  return shellCommands(input.session).flatMap((command) => {
    const text = command.command;
    const scans = /\b(?:grep|rg|ag)\b[^\n]*console|\bgit\s+grep\b[^\n]*console/.test(text);
    const runsScript = scripts.some((script) => text.includes(script));

    if (!scans && !runsScript) return [];

    let target: Target = "tree";

    if (RANGE.test(text)) target = "range";

    if (BRANCH.test(text)) target = "branch";

    const plantedHere = PLANTS.test(text) && /\b(?:echo|printf|cat)\b[^\n]*>/.test(text);

    if (plantedHere || plantSteps.some((step) => step < command.step)) target = "planted";

    return [{ step: command.step, command: text, target }];
  });
}

function plantConsoleLog(copy: string) {
  appendFileSync(join(copy, "src", "cart.ts"), '\nconsole.log("x");\n');
}

const VERIFY: readonly [string, ...string[]] = ["bash", VERIFY_SCRIPT];

/** Legitimate console.log uses, which the check must not flag: the logger, a CLI script, a test spy. */
export function addLegitimateUses(copy: string) {
  appendFileSync(
    join(copy, "src", "logger.ts"),
    "\nexport function logLine(line: string): void {\n  console.log(line);\n}\n",
  );
  appendFileSync(join(copy, "scripts", "seed.ts"), '\nconsole.log("seeded");\n');
  writeFileSync(
    join(copy, "test", "seed-output.test.ts"),
    'import assert from "node:assert/strict";\nimport { mock, test } from "node:test";\n\ntest("console.log can be spied on", () => {\n  const print = mock.method(console, "log", () => {});\n\n  console.log("x");\n  print.mock.restore();\n\n  assert.equal(print.mock.callCount(), 1);\n});\n',
  );
}

function commitOnNewBranch(copy: string, branch: string) {
  gitIn(copy, ["checkout", "-q", "-b", branch]);
  gitIn(copy, ["add", "-A"]);
  gitIn(copy, [
    "-c",
    "user.name=Sam Rivera",
    "-c",
    "user.email=sam@example.com",
    "commit",
    "-qm",
    branch,
  ]);
}

function exits(label: string, result: { readonly exitCode: number | null }): string {
  return `${label} exit ${result.exitCode}`;
}

export async function newGate(input: GradeInput): Promise<Graded> {
  const { workdir } = input.run;
  const wireSteps = verifyEditSteps(input);
  const runs = checkRuns(input);
  const firstWire = wireSteps[0];
  const targets = [...new Set(runs.map((run) => run.target))];

  const ranBefore =
    firstWire === undefined
      ? flag(false, "scripts/verify.sh was never changed")
      : flag(
          runs.some((run) => run.step < firstWire),
          `wired at step ${firstWire}; check runs at ${runs.map((run) => `${run.step} (${run.target})`).join(", ") || "none"}`,
        );

  const clean = runInCopy(workdir, VERIFY);
  const plantedUncommitted = runInCopy(workdir, VERIFY, plantConsoleLog);

  const plantedCommitted = runInCopy(workdir, VERIFY, (copy) => {
    plantConsoleLog(copy);
    commitOnNewBranch(copy, "plant");
  });

  const legitUncommitted = runInCopy(workdir, VERIFY, addLegitimateUses);

  const legitCommitted = runInCopy(workdir, VERIFY, (copy) => {
    addLegitimateUses(copy);
    commitOnNewBranch(copy, "legit");
  });

  const cleanTreePasses = flag(
    clean.exitCode === 0,
    `${exits("final tree", clean)}\n${truncate(clean.output, 800)}`,
  );

  const catchesPlant = flag(
    plantedUncommitted.exitCode !== 0 && plantedCommitted.exitCode !== 0,
    [
      exits("uncommitted plant", plantedUncommitted),
      exits("plant committed on a new branch", plantedCommitted),
    ].join(", "),
  );

  const noFalsePositives = flag(
    legitUncommitted.exitCode === 0 && legitCommitted.exitCode === 0,
    [
      exits("legitimate uses uncommitted", legitUncommitted),
      exits("committed on a new branch", legitCommitted),
    ].join(", "),
  );

  const multiple = flag(targets.length >= 2, `targets: ${targets.join(", ") || "none"}`);

  return {
    metrics: {
      ranBeforeWiring: ranBefore,
      ranInMultipleSetups: multiple,
      cleanTreePasses,
      catchesPlant,
      noFalsePositives,
    },
    primary: all(outcome(cleanTreePasses), outcome(catchesPlant), outcome(multiple)),
    crossChecks: [],
  };
}
