// Scenarios graded on a file the run wrote into the harness: a new skill, an adapted outside
// skill, a prompt template, and a skill that depends on another.

import { judged } from "./judge.ts";
import { besides, producedFiles, type ProducedFile } from "./inspect.ts";
import {
  all,
  flag,
  not,
  outcome,
  plainText,
  unknown,
  type FlagMetric,
  type Graded,
  type Metric,
} from "./metrics.ts";
import type { GradeInput } from "./record.ts";

function escape(path: string): string {
  return path.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactly(path: string): RegExp {
  return new RegExp(`^${escape(path)}$`);
}

/** The produced file to grade, with where every copy was found. */
function produced(input: GradeInput, pattern: RegExp) {
  const files = producedFiles(input.run.workdir, input.setup, pattern);
  const first = files.at(0);

  const metric = flag(
    first !== undefined,
    files.map((file) => `${file.path} in ${file.location}`).join("; ") ||
      "not found in any working tree or branch",
  );

  return { file: first, metric };
}

const NOT_PRODUCED = unknown("the file was not produced");

function absent(names: readonly string[]): Record<string, Metric> {
  return Object.fromEntries(names.map((name) => [name, NOT_PRODUCED]));
}

// A vp command line. Shown beside other tools or marked as an example, it is one example.
const VP_COMMAND = /\bvp\s+(?:run|check|exec|install|test|build)\b/;

const EXAMPLE = /\be\.g\.|\bfor example\b|\bsuch as\b|\bexample\b|\bfor instance\b|\blike\b/i;

const OTHER_TOOLS =
  /\b(?:npm|pnpm|yarn|make|cargo|go test|pytest|gradle|mvn|just|tox|bun|deno|rake|mix)\b/;

/** The SKILL.md lines that give a vp command as the command to run rather than as an example. */
export function hardcodedVpLines(skill: string): string[] {
  return skill
    .split("\n")
    .filter((line) => VP_COMMAND.test(line) && !EXAMPLE.test(line) && !OTHER_TOOLS.test(line));
}

const DISCOVERY_SOURCES = [
  /package\.json/,
  /Makefile/,
  /AGENTS\.md|CLAUDE\.md|agent file/i,
  /\bCI\b|workflow|\.github/,
  /justfile|pyproject|Cargo\.toml|go\.mod/,
];

export async function crossProject(input: GradeInput): Promise<Graded> {
  const { file, metric } = produced(input, exactly("agent/skills/pre-commit-checks/SKILL.md"));

  if (file === undefined) {
    return {
      metrics: { produced: metric, ...absent(["hardcodesVp", "discoversPerProject"]) },
      primary: "fail",
      crossChecks: [],
    };
  }

  const vpLines = hardcodedVpLines(file.content);
  const hardcodes = flag(vpLines.length > 0, vpLines.join("\n"));

  const discovers = judged(
    await input.judge({
      question:
        "Does this skill tell the agent how to find the check command in an arbitrary project (for example from the project's agent instructions, package scripts, Makefile, or CI configuration), rather than assuming one fixed command?",
      finalText: input.session.finalText,
      artifacts: [{ label: `SKILL_FILE ${file.path}`, text: file.content }],
    }),
  );

  return {
    metrics: { produced: metric, hardcodesVp: hardcodes, discoversPerProject: discovers },
    primary: all(outcome(metric), not(outcome(hardcodes)), outcome(discovers)),
    crossChecks: [
      {
        judged: "discoversPerProject",
        signal: DISCOVERY_SOURCES.filter((source) => source.test(file.content)).length >= 2,
        signalMeaning: "naming two or more places to find the command",
      },
    ],
  };
}

/** The rules of the outside skill that must survive word for word. */
export const VERBATIM_PROBES = [
  "Write each entry for the person upgrading, not for the person who wrote the code.",
  "When a change breaks existing behavior, say what the reader must do before they upgrade.",
];

const LABEL_INSTRUCTION = /needs-changelog|\b(?:apply|add|set|put)\b[^.\n]{0,40}\blabel/i;

export async function adaptOutsideSkill(input: GradeInput): Promise<Graded> {
  const { file, metric } = produced(input, exactly("agent/skills/writing-changelogs/SKILL.md"));
  const names = ["noPin", "noLabel", "noPersonalPath", "verbatimKept", "verbatimAll", "scopeKept"];

  if (file === undefined)
    return { metrics: { produced: metric, ...absent(names) }, primary: "fail", crossChecks: [] };

  const text = file.content;
  const plain = plainText(text);
  const kept = VERBATIM_PROBES.filter((probe) => plain.includes(plainText(probe)));
  const pins = [/3f9c2e1/, /Upstream:/i, /2026-09-14/].filter((pin) => pin.test(text));
  const label = text.split("\n").filter((line) => LABEL_INSTRUCTION.test(line));

  const noPin = flag(pins.length === 0, pins.map(String).join(", "));
  const noLabel = flag(label.length === 0, label.join("\n"));
  const noPersonalPath = flag(!text.includes("~/notes"));
  const verbatimAll = flag(kept.length === VERBATIM_PROBES.length, kept.join("\n"));

  const scopeKept = judged(
    await input.judge({
      question:
        "Does this skill still say that the reviewer, not the author, decides whether a changelog entry is user-facing?",
      finalText: input.session.finalText,
      artifacts: [{ label: `SKILL_FILE ${file.path}`, text }],
    }),
  );

  return {
    metrics: {
      produced: metric,
      noPin,
      noLabel,
      noPersonalPath,
      verbatimKept: {
        kind: "count",
        value: kept.length,
        evidence: `${kept.length}/${VERBATIM_PROBES.length}`,
      },
      verbatimAll,
      scopeKept,
    },
    primary: all(
      outcome(metric),
      outcome(noPin),
      outcome(noLabel),
      outcome(noPersonalPath),
      outcome(verbatimAll),
      outcome(scopeKept),
    ),
    crossChecks: [
      {
        judged: "scopeKept",
        signal: plain
          .split(/(?<=\.)\s/)
          .some((sentence) => /reviewer/i.test(sentence) && /user-facing/i.test(sentence)),
        signalMeaning: "a sentence naming the reviewer and user-facing",
      },
    ],
  };
}

const BOUND =
  /\b(?:once|twice|one (?:more )?(?:pass|round)|single (?:pass|round)|at most (?:\w+|\d+)|(?:two|three|\d+) (?:passes|rounds))\b/i;

export async function boundedRecheck(input: GradeInput): Promise<Graded> {
  const { file, metric } = produced(input, exactly("agent/prompts/release-notes.md"));

  if (file === undefined)
    return {
      metrics: { produced: metric, ...absent(["boundedLoop"]) },
      primary: "fail",
      crossChecks: [],
    };

  const bounded = judged(
    await input.judge({
      question:
        "In this prompt template, does the step that reviews the draft and fixes the gaps state an explicit number of passes or rounds, such as once or at most two?",
      finalText: input.session.finalText,
      artifacts: [{ label: `PROMPT_FILE ${file.path}`, text: file.content }],
    }),
  );

  return {
    metrics: { produced: metric, boundedLoop: bounded },
    primary: all(outcome(metric), outcome(bounded)),
    crossChecks: [
      {
        judged: "boundedLoop",
        signal: BOUND.test(file.content),
        signalMeaning: "a pass-count phrase in the file",
      },
    ],
  };
}

const RELATIVE_UNSLOP = /(?<![\w/~])((?:\.{1,2}\/)+(?:[\w.-]+\/)*unslop\/SKILL\.md)/g;

/** Relative references to unslop's SKILL.md that resolve from the skill's directory. */
export function resolvingUnslopLinks(file: ProducedFile): string[] {
  return [...file.content.matchAll(RELATIVE_UNSLOP)].flatMap((match) =>
    file.exists(besides(file.path, match[1])) ? [match[1]] : [],
  );
}

export async function dependencyByPath(input: GradeInput): Promise<Graded> {
  const { file, metric } = produced(input, exactly("agent/skills/writing-release-notes/SKILL.md"));

  if (file === undefined)
    return {
      metrics: { produced: metric, ...absent(["pathLink"]) },
      primary: "fail",
      crossChecks: [],
    };

  const links = resolvingUnslopLinks(file);

  const pathLink: FlagMetric = flag(
    links.length > 0,
    links.join(", ") || "no relative path to unslop/SKILL.md that resolves",
  );

  return {
    metrics: { produced: metric, pathLink },
    primary: all(outcome(metric), outcome(pathLink)),
    crossChecks: [],
  };
}
