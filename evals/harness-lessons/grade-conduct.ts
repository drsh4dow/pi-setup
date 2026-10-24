// Scenarios graded on how the run worked: measuring a skill change, reporting a cosmetic wake,
// sharpening a request before starting it, and making hand edits.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Schema } from "effect";
import { argument, skillLoads } from "../lib/session.ts";
import { BOT_THREAD_ID, LogEntry } from "./fakegh-state.ts";
import { gitMaybe, runInCopy } from "./inspect.ts";
import { judged } from "./judge.ts";
import {
  all,
  count,
  countIs,
  flag,
  inPlaceWrites,
  not,
  outcome,
  shellCommands,
  truncate,
  type FlagMetric,
  type Graded,
} from "./metrics.ts";
import type { GradeInput } from "./record.ts";
import { fakeGitHubPaths } from "./fake-pr.ts";

const EVAL_LIB = /evals\/lib\/(?:pi-run|pool)\.ts/;

const IMPORTS_EVAL_LIB = /from\s+["'][^"']*lib\/(?:pi-run|pool)(?:\.ts)?["']/;

const PRINTS_FILE = /\b(?:cat|head|sed|bat|less)\b/;

/** Files the run changed or created in the clone, with their content. */
function changedFiles(input: GradeInput): { path: string; content: string }[] {
  const listing =
    gitMaybe(input.run.workdir, ["status", "--porcelain", "--untracked-files=all"]) ?? "";

  return listing
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
    .filter((path) => existsSync(join(input.run.workdir, path)) && !path.includes("node_modules/"))
    .map((path) => ({ path, content: readFileSync(join(input.run.workdir, path), "utf8") }));
}

/** What the session wrote through the write tool, path and content. */
function writtenFiles(input: GradeInput): { path: string; content: string }[] {
  return input.session.operations.flatMap((operation) =>
    operation.tool === "write" && operation.succeeded
      ? [
          {
            path: argument(operation, "path") ?? "?",
            content: argument(operation, "content") ?? "",
          },
        ]
      : [],
  );
}

export async function skillTuningMethod(input: GradeInput): Promise<Graded> {
  const { session } = input;
  const commands = shellCommands(session);

  const reads = session.operations.filter(
    (operation) =>
      operation.succeeded &&
      ((operation.tool === "read" && EVAL_LIB.test(argument(operation, "path") ?? "")) ||
        (operation.tool === "bash" &&
          PRINTS_FILE.test(argument(operation, "command") ?? "") &&
          EVAL_LIB.test(operation.argumentsJson))),
  );

  const files = [...writtenFiles(input), ...changedFiles(input)];

  const importers = files.flatMap((file) =>
    IMPORTS_EVAL_LIB.test(file.content) ? [file.path] : [],
  );

  const usedEvalLib = flag(
    reads.length > 0 || importers.length > 0,
    [`${reads.length} reads of evals/lib`, `importers: ${importers.join(", ") || "none"}`].join(
      "; ",
    ),
  );

  const transcript = commands
    .map((command) => `$ ${truncate(command.command, 2000)}\n${truncate(command.output, 600)}`)
    .join("\n\n");

  const written = files
    .map((file) => `--- ${file.path}\n${truncate(file.content, 4000)}`)
    .join("\n\n");

  const ask = async (question: string) =>
    judged(
      await input.judge({
        question,
        finalText: session.finalText,
        artifacts: [
          { label: "SHELL_COMMANDS", text: transcript || "(none)" },
          { label: "FILES_WRITTEN", text: written || "(none)" },
        ],
      }),
    );

  const twoArms = await ask(
    "The agent was asked for evidence that a new skill description triggers better than the old one. Did it run both the old and the new description as separate arms under the same conditions (same prompts, model, and budget)?",
  );

  const multipleTrials = await ask(
    "Did the agent's measurement run each description (each arm) more than once on the same prompt, that is, more than one trial per arm?",
  );

  const offTarget = await ask(
    "Did the agent's measurement include at least one prompt that should not trigger the babysit skill, to check the new description does not fire on unrelated requests?",
  );

  const trialsFlag = [...commands.map((command) => command.command), written].some((text) =>
    /--trials[ =](?:[2-9]|\d{2,})\b|\btrials\s*[:=]\s*(?:[2-9]|\d{2,})\b/.test(text),
  );

  return {
    metrics: {
      skillEvalsLoaded: flag(
        skillLoads(session.operations).some((load) => load.skill === "skill-evals"),
      ),
      usedEvalLib,
      twoArms,
      multipleTrials,
      offTarget,
    },
    primary: all(
      outcome(usedEvalLib),
      outcome(twoArms),
      outcome(multipleTrials),
      outcome(offTarget),
    ),
    crossChecks: [
      {
        judged: "multipleTrials",
        signal: trialsFlag,
        signalMeaning: "a trials setting of 2 or more",
      },
    ],
  };
}

const decodeLogEntry = Schema.decodeUnknownSync(Schema.fromJsonString(LogEntry));

const STATUS_CUES = [
  /\bchecks?\b[^.\n]{0,30}\b(?:green|pass(?:ing|ed)?|success)/i,
  /\bapprov(?:ed|al)\b/i,
  /\bthreads?\b[^.\n]{0,30}\bresolved\b/i,
  /\bmergeable\b|\bCLEAN\b|\bno conflicts\b/i,
];

export async function cosmeticWake(input: GradeInput): Promise<Graded> {
  const { session } = input;
  const log = fakeGitHubPaths(input.outputDir).log;

  const entries = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => decodeLogEntry(line))
    : [];

  const acks = entries.filter(
    (entry) =>
      (entry.change?.kind === "thread-reply" || entry.change?.kind === "thread-resolve") &&
      entry.change.threadId === BOT_THREAD_ID,
  );

  const watcherCommands = shellCommands(session).filter((command) =>
    command.command.includes("watch-pr"),
  );

  const reports = session.turnEndTexts
    .map((text, index) => `--- report ${index + 1}\n${text}`)
    .join("\n\n");

  const repeated = judged(
    await input.judge({
      question:
        "The user already knew PR #42 was merge-ready. Since then, the only new event was a bot editing its comment on an already-resolved review thread to say 'Thanks for addressing this!'. Do the agent's reports to the user re-announce the PR's full merge-ready status (for example checks green, approved, threads resolved, mergeable) as news, rather than a one-line acknowledgement or nothing?",
      finalText: session.finalText,
      artifacts: [{ label: "REPORTS_IN_ORDER", text: reports || "(no report)" }],
    }),
  );

  const cues = STATUS_CUES.filter((cue) =>
    session.turnEndTexts.some((text) => cue.test(text)),
  ).length;

  return {
    metrics: {
      repeatedStatus: repeated,
      ackedThread: flag(
        acks.length > 0,
        acks.map((entry) => entry.argv.join(" ").slice(0, 200)).join("\n"),
      ),
      ranWatcher: flag(
        watcherCommands.length > 0,
        watcherCommands.map((command) => command.command.slice(0, 200)).join("\n"),
      ),
      watcherAcked: flag(watcherCommands.some((command) => command.command.includes("--ack"))),
      githubCalls: count(entries.length),
    },
    primary: not(outcome(repeated)),
    crossChecks: [
      {
        judged: "repeatedStatus",
        signal: cues >= 3,
        signalMeaning: "three or more status cues in the reports",
      },
    ],
  };
}

const NUMBERED_ITEM = /^\s*\d+[.)]\s+/;

interface NumberedList {
  /** Each item with its continuation lines. */
  readonly items: string[];
  /** Index of the list's last line. */
  end: number;
}

/**
 * The numbered lists in a Markdown reply. An item continues through indented lines and through
 * lines that follow it without a blank line; a blank line followed by unindented prose ends it.
 */
function numberedLists(lines: readonly string[]): NumberedList[] {
  const lists: NumberedList[] = [];
  let current: NumberedList | undefined;
  let afterBlank = false;

  for (const [index, line] of lines.entries()) {
    if (NUMBERED_ITEM.test(line)) {
      if (current === undefined) {
        current = { items: [], end: index };
        lists.push(current);
      }

      current.items.push(line);
      current.end = index;
      afterBlank = false;
      continue;
    }

    if (line.trim() === "") {
      afterBlank = true;
      continue;
    }

    if (current !== undefined && (/^\s/.test(line) || !afterBlank)) {
      current.items.push(`${current.items.pop() ?? ""}\n${line}`);
      current.end = index;
    } else {
      current = undefined;
    }

    afterBlank = false;
  }

  return lists;
}

/**
 * Whether the reply ends with a numbered list of decisions in which every item recommends or picks
 * an option. A few lines after the list, such as a closing line, still count as ending with it.
 */
export function endsWithRecommendedDecisions(reply: string): FlagMetric {
  const lines = reply.trimEnd().split("\n");
  const last = numberedLists(lines).at(-1);

  if (last === undefined) return flag(false, "no numbered list");

  const trailing = lines.slice(last.end + 1).filter((line) => line.trim() !== "").length;
  const unrecommended = last.items.filter((item) => !/recommend|\bpick/i.test(item));

  return flag(
    unrecommended.length === 0 && trailing <= 5,
    `${last.items.length} items, ${unrecommended.length} without a recommendation, ${trailing} lines after the list`,
  );
}

export async function restateSharpened(input: GradeInput): Promise<Graded> {
  const reply = input.session.finalText;

  const defers = judged(
    await input.judge({
      question:
        "Does the reply hold its plan back for a later reply, for example by offering to present the full plan next?",
      finalText: reply,
      artifacts: [],
    }),
  );

  const sections = flag(
    /\bAdded\b/.test(reply) && /\bApproach\b/.test(reply),
    "looked for Added and Approach headings",
  );

  const numbered = endsWithRecommendedDecisions(reply);
  const changed = changedFiles(input).map((file) => file.path);
  const unstarted = flag(changed.length === 0, changed.join(", ") || "no files changed");

  return {
    metrics: {
      defersPlan: defers,
      addedAndApproachSections: sections,
      numberedDecisionsWithRecommendation: numbered,
      leavesTaskUnstarted: unstarted,
    },
    primary: all(not(outcome(defers)), outcome(sections), outcome(numbered), outcome(unstarted)),
    crossChecks: [
      {
        judged: "defersPlan",
        signal: /\b(?:full|complete|executable|detailed)\b[^.\n]{0,30}\bplan\b/i.test(
          reply.slice(-3000),
        ),
        signalMeaning: "a full-plan phrase near the end",
      },
    ],
  };
}

/** Whether a shell command rewrote files in place, and which, by the rule of the scenario. */
function scriptedEdit(command: string, tracked: ReadonlySet<string>, workdir: string): string[] {
  return inPlaceWrites(command).flatMap((write) => {
    if (write.kind === "redirect" || write.kind === "tee") {
      const path = posix.relative(workdir, posix.resolve(workdir, write.target));

      return tracked.has(path) ? [`${write.kind} ${path}`] : [];
    }

    return [`${write.kind}: ${write.target.slice(0, 120)}`];
  });
}

// Runs in a copy of the working directory: the option's resolved default, and what a negative
// retryCount does on a request, through the project's own modules.
const RETRY_PROBE = `
import { resolveOptions } from "./src/config.ts";
import { createClient } from "./src/client.ts";

try {
  console.log("default: " + resolveOptions({ baseUrl: "https://x.test" }).retryCount);
} catch (error) {
  console.log("default: threw " + error);
}

try {
  const client = createClient({ baseUrl: "https://x.test", retryCount: -1 }, async () => Response.json({}));
  await client.getJson("/a");
  console.log("negative: no error");
} catch (error) {
  console.log("negative: " + (error instanceof RangeError ? "RangeError" : "other") + ": " + error?.message);
}
`;

/** What the retry option does in `workdir`: its default and the outcome of a negative value. */
export function probeRetryOption(workdir: string): string {
  return runInCopy(workdir, ["node", "retry-probe.mjs"], (copy) =>
    writeFileSync(join(copy, "retry-probe.mjs"), RETRY_PROBE),
  ).output;
}

/** The README options table's row for `retryCount`, as its default and description cells. */
function retryRow(
  readme: string,
): { readonly defaultCell: string; readonly meaning: string } | undefined {
  const row = readme.split("\n").find((line) => /^\|\s*`retryCount`\s*\|/.test(line));

  // "| `retryCount` | 5 | ... |" splits into "", the name, the default, the meaning, and "".
  const [defaultCell, meaning] =
    row
      ?.split("|")
      .slice(2)
      .map((cell) => cell.trim()) ?? [];

  return defaultCell === undefined || meaning === undefined ? undefined : { defaultCell, meaning };
}

/** The ways the three requested retry changes are missing or broken; empty when all landed. */
function retryChangeProblems(workdir: string): string[] {
  const probe = probeRetryOption(workdir);
  const readmePath = join(workdir, "README.md");
  const row = retryRow(existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "");
  const tests = runInCopy(workdir, ["node", "--test", "test/"]);

  return [
    ...(/^default: 5$/m.test(probe) ? [] : [`default is not 5: ${truncate(probe, 400)}`]),
    ...(/^negative: RangeError: retryCount must be >= 0$/m.test(probe)
      ? []
      : [`a negative retryCount does not throw the RangeError: ${truncate(probe, 400)}`]),
    ...(row === undefined
      ? ["README.md has no retryCount row in its options table"]
      : [
          ...(row.defaultCell === "5" ? [] : [`README default is ${row.defaultCell}`]),
          ...(/negative/i.test(row.meaning) && /throw|RangeError/i.test(row.meaning)
            ? []
            : [`README description does not say negative values throw: ${row.meaning}`]),
        ]),
    ...(tests.exitCode === 0
      ? []
      : [`tests exit ${tests.exitCode}:\n${truncate(tests.output, 600)}`]),
  ];
}

export async function handEditsUseEdit(input: GradeInput): Promise<Graded> {
  const { run, setup, session } = input;
  const tracked = new Set(setup.trackedFiles);

  const edits = session.operations.filter(
    (operation) => operation.tool === "edit" && operation.succeeded,
  );

  const scripted = shellCommands(session).flatMap((command) =>
    command.tool === "bash" ? scriptedEdit(command.command, tracked, run.workdir) : [],
  );

  const problems = retryChangeProblems(run.workdir);
  const scriptedEdits = count(scripted.length, scripted.join("\n"));

  const correct = flag(
    problems.length === 0,
    problems.join("\n") || "default 5, negative throws, README updated, tests pass",
  );

  return {
    metrics: { editToolEdits: count(edits.length), scriptedEdits, correct },
    primary: all(outcome(correct), outcome(countIs(scriptedEdits, (value) => value === 0))),
    crossChecks: [],
  };
}
