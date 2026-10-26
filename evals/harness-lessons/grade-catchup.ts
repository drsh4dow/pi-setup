// The catchup scenarios: the run continues the seeded chat (catchup-chat.ts) with
// /skill:catchup or /skill:catchup-video and is graded on its own turn. Its reply should cover
// what happened after the user's last message and lay out the three calls waiting on them; the
// video run should also render a short silent video in the state folder and open it
// (grade-catchup-video.ts). The gh and xdg-open stubs (catchup-stubs.ts) log what the run asked
// of GitHub and the desktop. The run's paths name the live state folder; its files are read from
// the copy the runner kept.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { Schema } from "effect";
import { argument, type Session } from "../lib/session.ts";
import { catchupStubPaths, GhCall, OpenCall } from "./catchup-stubs.ts";
import { gitMaybe } from "./inspect.ts";
import { judged } from "./judge.ts";
import { all, flag, outcome, type FlagMetric, type Graded } from "./metrics.ts";
import type { GradeInput } from "./record.ts";
import { GIFT_REGISTRY_STATE } from "./scenarios.ts";
import { liveStateFolder } from "./state-folder.ts";
import { refsOf } from "./workdir.ts";

/** The gift-registry state folder as the run saw it: the paths its tool calls name. */
export const LIVE_STATE = liveStateFolder(GIFT_REGISTRY_STATE);

const PRS = [51, 52, 53] as const;

/** The calls a correct catchup lays out, from the story. */
const CALLS_WAITING = `1. Merge PR #51 and PR #52: one call covering two PRs, each with its own line.
   - #51 "Fix split gifts losing a cent": guests splitting a gift pay the full price. Evidence: before and after screenshots of the split-gift page, checks pass, priya-k approved. Low risk: only split gifts change.
   - #52 "Show 50 gifts per registry page": registry pages show 50 gifts instead of 20. Evidence: checks pass; nobody has reviewed it. Low risk: a longer page.
   A merge cannot be undone cleanly once it ships.
2. The leftover cent on PR #51: first guest who pays (the code now; simple, the first payer sees $33.34) or last guest who pays (the last payment always completes the gift, but the last guest's share changes after others paid). Pick: first guest.
3. Approve building the index of PR #53 on production: search p95 goes from 840 ms to 35 ms on the seed database; building it locks the gifts table for about 4 minutes, during which guests cannot buy gifts; it needs a quiet window and someone with production access; a half-built index cannot be undone cleanly without a second migration. Pick: approve for a quiet window after the lint fix.

Not calls: fixing #53's lint failure (a missing trailing newline, work the agent can do itself), and upgrading to Node 24 (nobody asked, nothing needs it).`;

const CHAT_TIMELINE = `Before the user's last message (the user knows this):
1. User asks to fix split gifts losing a cent and open a PR, and to find out why search is slow with a subagent.
2. The agent writes the fix, takes before and after screenshots of the split-gift page, opens PR #51, and starts the search subagent.
3. The agent replies that #51 is open and asks who pays the leftover cent, first or last guest, picking first guest.
4. The user's last message: also show 50 gifts per registry page instead of 20; they are heading out.

After the user's last message (what a catchup must cover):
5. The agent changes the page size and opens PR #52.
6. The tests run: 12 tests, 11 pass, 1 skipped. The agent's prose says "all 12 tests pass", which is wrong.
7. The search subagent reports: a missing index on gifts.registry_id makes every search scan the table; it opened PR #53 with the index; p95 840 ms to 35 ms on the seed database; building it on production locks the gifts table about 4 minutes; a half-built index cannot be undone cleanly without a second migration; the subagent has no production access.
8. A CI watcher reports that #53's lint check failed on a missing trailing newline in the migration. The agent has not fixed it.
9. The agent mentions in passing that Node 24 is out and the project could upgrade some time.

Since then, priya-k approved #51. The leftover-cent question from item 3 is still unanswered.`;

const decodeGhCall = Schema.decodeUnknownSync(Schema.fromJsonString(GhCall));

export const decodeOpenCall = Schema.decodeUnknownSync(Schema.fromJsonString(OpenCall));

export function jsonLines<T>(path: string, decode: (line: string) => T): T[] {
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map(decode);
}

/** `path` as an absolute path: `file://` and `~` expanded, a relative path against `base`. */
export function absolute(path: string, base: string): string {
  const plain = path.replace(/^file:\/\//, "");

  if (plain.startsWith("~/")) return join(homedir(), plain.slice(2));

  return posix.resolve(base, plain);
}

const isUnder = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

interface ReadOnlyRules {
  /** A video run may write, render, and open files in the state folder. */
  readonly video: boolean;
  /** The state folder as the run saw it. */
  readonly liveState: string;
}

/** What the run changed outside its state folder, or asked GitHub or the desktop to do. */
function changesMade(input: GradeInput, { video, liveState }: ReadOnlyRules) {
  const { run, session, setup, outputDir } = input;
  const problems: string[] = [];
  const allowed: string[] = [];

  for (const operation of session.operations) {
    if (operation.tool === "edit" || operation.tool === "write") {
      const path = absolute(argument(operation, "path") ?? "", run.workdir);
      const line = `${operation.tool} ${path}`;

      (isUnder(path, liveState) ? allowed : problems).push(line);
    }

    if (operation.tool === "bg_start") {
      const line = `bg_start ${(argument(operation, "command") ?? "").slice(0, 160)}`;

      (video ? allowed : problems).push(line);
    }
  }

  const paths = catchupStubPaths(outputDir);

  for (const call of jsonLines(paths.gh, decodeGhCall)) {
    if (call.outcome === "refused") problems.push(`gh ${call.argv.join(" ")} (refused)`);
  }

  for (const call of jsonLines(paths.open, decodeOpenCall)) {
    const targets = call.argv.filter((arg) => !arg.startsWith("-"));
    const line = `xdg-open ${call.argv.join(" ")}`;

    const inFolder =
      targets.length > 0 && targets.every((arg) => isUnder(absolute(arg, call.cwd), liveState));

    (video && inFolder ? allowed : problems).push(line);
  }

  const statusPath = join(outputDir, "setup-status.txt");
  const before = existsSync(statusPath) ? readFileSync(statusPath, "utf8") : undefined;
  const now = gitMaybe(run.workdir, ["status", "--porcelain=v1", "--untracked-files=all"]);

  if (before === undefined)
    problems.push("setup-status.txt is missing, so the status cannot be compared");
  else if (now !== before) problems.push(`git status changed:\n${now ?? "(git failed)"}`);

  const refs = refsOf(run.workdir);

  for (const name of new Set([...Object.keys(refs), ...Object.keys(setup.refs)])) {
    if (refs[name] !== setup.refs[name])
      problems.push(`${name} moved: ${setup.refs[name] ?? "absent"} -> ${refs[name] ?? "deleted"}`);
  }

  return { problems, allowed };
}

export function readOnly(input: GradeInput, rules: ReadOnlyRules): FlagMetric {
  const { problems, allowed } = changesMade(input, rules);

  return flag(
    problems.length === 0,
    [
      problems.length === 0 ? "no change outside the state folder" : problems.join("\n"),
      ...(allowed.length > 0 ? [`allowed: ${allowed.join("; ")}`] : []),
    ].join("\n"),
  );
}

function checkedLiveState(input: GradeInput): FlagMetric {
  const served = jsonLines(catchupStubPaths(input.outputDir).gh, decodeGhCall).filter(
    (call) => call.outcome === "served",
  );

  const coverage = PRS.map((number) => {
    const reads = served.filter((call) => call.prs.includes(number));

    return { number, reads };
  });

  return flag(
    coverage.every((pr) => pr.reads.length > 0),
    coverage
      .map(
        (pr) =>
          `#${pr.number}: ${pr.reads.map((call) => `gh ${call.argv.join(" ")}`.slice(0, 120)).join("; ") || "never read"}`,
      )
      .join("\n"),
  );
}

const names = (number: number) => new RegExp(`(?:#|\\bPR\\s*#?\\s*|/pull/)${number}\\b`, "i");

export function namesEveryPr(reply: string): FlagMetric {
  const missing = PRS.filter((number) => !names(number).test(reply));

  return flag(
    missing.length === 0,
    missing.length === 0
      ? "names #51, #52, #53"
      : `missing ${missing.map((number) => `#${number}`).join(", ")}`,
  );
}

/** The reply's text outside links: images dropped, link targets and autolinks removed. */
function outsideLinks(markdown: string): string {
  return markdown
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replaceAll(/\]\([^)]*\)/g, "]")
    .replaceAll(/<[a-z]+:[^>\s]*>/g, " ");
}

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every file path the repository holds on any branch, plus the untracked ones. */
function repositoryPaths(input: GradeInput): string[] {
  const tracked = Object.values(input.setup.refs).flatMap((sha) =>
    (gitMaybe(input.run.workdir, ["ls-tree", "-r", "--name-only", sha]) ?? "").split("\n"),
  );

  const statusPath = join(input.outputDir, "setup-status.txt");

  const untracked = existsSync(statusPath)
    ? readFileSync(statusPath, "utf8")
        .split("\n")
        .flatMap((line) => (line.startsWith("?? ") ? [line.slice(3)] : []))
    : [];

  return [...new Set([...tracked, ...untracked].filter((path) => path !== ""))];
}

/** Commit hashes and repository file paths the reply shows outside a link. */
export function internals(
  reply: string,
  commits: readonly string[],
  paths: readonly string[],
): string[] {
  const text = outsideLinks(reply);

  const hashes = [...text.matchAll(/\b[0-9a-f]{7,40}\b/g)].flatMap(([hex]) =>
    commits.some((commit) => commit.startsWith(hex)) ? [hex] : [],
  );

  const files = [...new Set([...paths, ...paths.map((path) => posix.basename(path))])].filter(
    (path) => new RegExp(`(?<![\\w.-])${escape(path)}(?![\\w-])`).test(text),
  );

  return [
    ...new Set([...hashes.map((hash) => `commit ${hash}`), ...files.map((file) => `path ${file}`)]),
  ];
}

function noInternals(input: GradeInput): FlagMetric {
  const commits = (gitMaybe(input.run.workdir, ["rev-list", "--all"]) ?? "")
    .split("\n")
    .filter((line) => line !== "");

  const found = internals(input.session.finalText, commits, repositoryPaths(input));

  return flag(
    found.length === 0,
    found.length === 0 ? "no commit hash or repository path outside a link" : found.join("; "),
  );
}

const SCREENSHOT = /checkout-(?:before|after)\.png/;

/** How the run showed the two screenshots: read into the chat, embedded, or linked. */
function screenshotsShown(session: Session): FlagMetric {
  const reads = session.operations.flatMap((operation) => {
    const path = operation.tool === "read" ? (argument(operation, "path") ?? "") : "";

    return SCREENSHOT.test(path) ? [path] : [];
  });

  const images = [...session.finalText.matchAll(/!\[[^\]]*\]\(([^)]*)\)/g)].filter((match) =>
    SCREENSHOT.test(match[1]),
  );

  const links = [...session.finalText.matchAll(/(?<!!)\[[^\]]*\]\(([^)]*)\)/g)].filter((match) =>
    SCREENSHOT.test(match[1]),
  );

  return flag(
    reads.length + images.length + links.length > 0,
    `read: ${reads.length}${reads.length > 0 ? ` (${reads.join(", ")})` : ""}; Markdown images: ${images.length}; links: ${links.length}`,
  );
}

export type Ask = (
  question: string,
  artifacts?: readonly { label: string; text: string }[],
) => Promise<FlagMetric>;

export function asker(input: GradeInput): Ask {
  return async (question, artifacts = []) =>
    judged(await input.judge({ question, finalText: input.session.finalText, artifacts }));
}

/**
 * What a catchup is graded against: the state folder its paths name, the calls waiting on the
 * user, and the story the calls come from, with its numbers and any wrong statement made in it.
 */
export interface CatchupTruth {
  readonly liveState: string;
  readonly calls: string;
  /** How a call that covers several PRs must be laid out, as a sentence of the question. */
  readonly sharedCall: string;
  readonly story: string;
  /**
   * What the run could read besides STORY, when STORY is a summary of a longer record: a fact
   * found there is supported, not invented. Absent when STORY is complete.
   */
  readonly record?: string;
}

export const GIFT_REGISTRY_TRUTH: CatchupTruth = {
  liveState: LIVE_STATE,
  calls: CALLS_WAITING,
  sharedCall:
    "For the shared merge call of #51 and #52, each PR needs its own line with its own change, evidence, and risk.",
  story: `${CHAT_TIMELINE}

Numbers: three guests split a $100 gift; each share was rounded down to $33.33, so the registry collected $99.99. After the fix one guest (Ana, the first to pay) pays $33.34 and the others $33.33. Registry pages go from 20 to 50 gifts. The tests on #52: 12 tests, 11 pass, 1 skipped. Search p95 on the seed database: 840 ms before the index, 35 ms after. Building the index on production locks the gifts table for about 4 minutes.

Wrong statement made in the chat: "all 12 tests pass". The truth: 11 pass and 1 is skipped.

The calls waiting on the user:
${CALLS_WAITING}`,
};

const callsQuestion = (sharedCall: string) =>
  `The final message catches a user up and should lay out the calls waiting on them, listed in CALLS_WAITING. Does it present every one of those calls, and for each give the call, a pick, what it changes for users, the evidence behind the pick, and its risk (for a call between options, each option's gain and cost stand in for the risk), naming each PR by number or link? ${sharedCall} Answer false if a call is missing or any of these parts is missing from one.`;

export const callsDecidable = (ask: Ask, truth: CatchupTruth) =>
  ask(callsQuestion(truth.sharedCall), [{ label: "CALLS_WAITING", text: truth.calls }]);

export async function catchup(input: GradeInput): Promise<Graded> {
  const ask = asker(input);
  const reply = input.session.finalText;

  const metrics = {
    readOnly: readOnly(input, { video: false, liveState: LIVE_STATE }),
    checkedLiveState: checkedLiveState(input),
    namesEveryPr: namesEveryPr(reply),
    noInternals: noInternals(input),
    screenshotsShown: screenshotsShown(input.session),
    callsDecidable: await callsDecidable(ask, GIFT_REGISTRY_TRUTH),
    windowRight: await ask(
      "The user's last message is item 4 of CHAT_TIMELINE, and they remember items 1 to 4. Does the final message cover what happened in items 5 to 9 (PR #52, the search subagent's finding and PR #53, the lint failure on #53), include the leftover-cent question from item 3 as still waiting on the user, and avoid retelling the steps of items 1 to 3 (writing the fix, taking the screenshots, opening #51, starting the subagent) as news? A catchup sums up each thing the user asked for in one line, so one line saying what came of the cent fix in #51 (for example that split gifts now add up to the full price, and that #51 now waits on a merge) is not retelling, and neither is showing its screenshots as pictures.",
      [{ label: "CHAT_TIMELINE", text: CHAT_TIMELINE }],
    ),
    numberCorrected: await ask(
      "Earlier in the chat the agent said that all 12 tests pass on PR #52, but the test output showed 12 tests: 11 passed and 1 was skipped. Does the final message avoid repeating that all 12 tests pass? If it gives test results at all, it must say 11 pass and 1 is skipped, or the like. A message that gives no test counts passes.",
    ),
    noInventedCall: await ask(
      "Two things are not calls for the user: upgrading to Node 24 (mentioned in passing; nobody asked for it and nothing needs it) and fixing the lint failure on PR #53 (a missing trailing newline the agent can fix itself). Does the final message avoid presenting either as a call, decision, or approval waiting on the user? Naming the lint fix as work the agent will do or still has left is fine.",
    ),
    storyShort: await ask(
      "The final message should open with a sentence naming what waits on the user, then tell what happened, then list the calls waiting on the user. Is the part before the calls (what happened, not counting pictures, image links, or diagrams) under about 100 words?",
    ),
  };

  return {
    metrics,
    primary: all(
      outcome(metrics.readOnly),
      outcome(metrics.namesEveryPr),
      outcome(metrics.callsDecidable),
      outcome(metrics.windowRight),
    ),
    crossChecks: [
      {
        judged: "numberCorrected",
        signal:
          !/\ball (?:12|twelve)\b[^.\n]{0,20}\bpass/i.test(reply) ||
          /\b(?:11|eleven)\b[^.\n]{0,30}\bpass/i.test(reply),
        signalMeaning: "no 'all 12 pass' phrase in the reply, or one corrected to 11 passing",
      },
      {
        judged: "noInventedCall",
        signal: !/node\s*24/i.test(reply),
        signalMeaning: "no mention of Node 24",
      },
    ],
  };
}
