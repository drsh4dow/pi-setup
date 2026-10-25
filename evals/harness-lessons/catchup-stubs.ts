#!/usr/bin/env node
// The `gh` and `xdg-open` of the catchup scenarios, put first on PATH by catchup-bin/. The `gh`
// serves PRs #51, #52, and #53 (catchup-prs.ts) and only reads: a call that would change GitHub
// is refused. `xdg-open` opens nothing. Both append every call, with its argv, to a JSON-lines
// log in $CATCHUP_LOG_DIR.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { Schema } from "effect";
import {
  PRS,
  REPO,
  REPO_FIELDS,
  VIEWER,
  checkFields,
  detailsUrl,
  failing,
  prFields,
  repoGit,
  restGet,
  urlOf,
  type Check,
  type Pr,
} from "./catchup-prs.ts";
import type { JsonValue } from "./fakegh-api.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

const GhOutcome = Schema.Literals(["served", "refused", "unsupported"]);

type GhOutcome = typeof GhOutcome.Type;

export const GhCall = Schema.Struct({
  at: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  /** Served a read, refused a change to GitHub, or failed a call the stub does not serve. */
  outcome: GhOutcome,
  /** The PRs whose state the reply showed: numbers here, URLs in the recorded scenario's stub. */
  prs: Schema.Array(Schema.Union([Schema.Int, Schema.String])),
});

export type GhCall = typeof GhCall.Type;

export const OpenCall = Schema.Struct({
  at: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
});

export type OpenCall = typeof OpenCall.Type;

export function catchupStubPaths(outputDir: string) {
  return { gh: join(outputDir, "gh-log.jsonl"), open: join(outputDir, "xdg-open-log.jsonl") };
}

/** The environment that puts the stubs first on PATH, logging to `outputDir`. */
export function catchupStubEnv(outputDir: string, workdir: string): NodeJS.ProcessEnv {
  return {
    PATH: `${join(HERE, "catchup-bin")}${delimiter}${process.env.PATH ?? ""}`,
    CATCHUP_LOG_DIR: outputDir,
    CATCHUP_REPO: workdir,
    GIT_TERMINAL_PROMPT: "0",
  };
}

export class GhExit extends Error {
  readonly code: number;
  readonly outcome: GhOutcome;
  constructor(message: string, outcome: GhOutcome = "unsupported") {
    super(message);
    this.code = 1;
    this.outcome = outcome;
  }
}

export interface Reply {
  readonly stdout: string;
  readonly prs: readonly (number | string)[];
  readonly exitCode: number;
}

export const refused = (command: string) =>
  new GhExit(
    `HTTP 403: Resource not accessible by personal access token (${command}). This token can only read.`,
    "refused",
  );

export const noBrowser = () => new GhExit("gh: cannot open a browser here");

/** Flags that take a value; every other flag is a switch. */
const VALUED = new Set(
  "--json --jq -q --repo -R --state -s --limit -L --author -A --method -X --field -F --raw-field -f --input --hostname --template -t --head -H --base -B --search -S --label -l --body -b --title".split(
    " ",
  ),
);

export interface Options {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
}

export function options(args: readonly string[]): Options {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();

  const put = (name: string, value: string) =>
    values.set(name, [...(values.get(name) ?? []), value]);

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const equals = arg.indexOf("=");

    if (!arg.startsWith("-") || arg === "-") positionals.push(arg);
    else if (arg.startsWith("--") && equals !== -1)
      put(arg.slice(0, equals), arg.slice(equals + 1));
    else if (VALUED.has(arg)) put(arg, args[++index] ?? "");
    else put(arg, "");
  }

  return { positionals, values };
}

export const valueOf = (opts: Options, ...names: readonly string[]) =>
  names.flatMap((name) => opts.values.get(name) ?? []).at(-1);

export const has = (opts: Options, ...names: readonly string[]) =>
  names.some((name) => opts.values.has(name));

function currentBranchPr(): Pr | undefined {
  const branch = spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" }).stdout;

  return PRS.find((pr) => pr.branch === branch.trim());
}

/** The PR a selector names: a number, `#n`, its URL, its branch, or none for the current branch. */
function findPr(selector: string | undefined): Pr {
  const match = /^(?:#?(\d+)|https:\/\/github\.com\/acme\/gift-registry\/pull\/(\d+)\/?)$/.exec(
    selector ?? "",
  );

  const number = match?.[1] ?? match?.[2];

  const found =
    selector === undefined
      ? currentBranchPr()
      : PRS.find((pr) => pr.branch === selector || String(pr.number) === number);

  if (found !== undefined) return found;

  throw new GhExit(
    selector === undefined
      ? "no pull requests found for the current branch"
      : `GraphQL: Could not resolve to a PullRequest with the number of ${selector}. (repository.pullRequest)`,
  );
}

/** The fields `--json a,b` selects from `record`, or gh's error for an unknown field. */
export function select(record: Readonly<Record<string, JsonValue>>, fields: string) {
  const names = fields.split(",").map((name) => name.trim());
  const missing = names.find((name) => !(name in record));

  if (fields !== "" && missing === undefined)
    return Object.fromEntries(names.map((name) => [name, record[name]]));

  const head =
    missing === undefined
      ? "Specify one or more comma-separated fields for `--json`:"
      : `Unknown JSON field: "${missing}"\nAvailable fields:`;

  const available = Object.keys(record)
    .toSorted()
    .map((name) => `  ${name}`);

  throw new GhExit([head, ...available].join("\n"));
}

/** What a `--json` call prints, through `--jq` when it names a filter. */
export function printJson(data: JsonValue, opts: Options): string {
  const filter = valueOf(opts, "--jq", "-q");
  const text = JSON.stringify(data, null, 2);

  if (filter === undefined) return `${text}\n`;

  const result = spawnSync("jq", ["-r", filter], { input: text, encoding: "utf8" });

  if (result.status !== 0) throw new GhExit(result.stderr.trim() || "jq failed");

  return result.stdout;
}

/** A reply: the records' `--json` selection when asked for, or else the text. */
export function reply(
  opts: Options,
  prs: Reply["prs"],
  records: () => JsonValue,
  text: () => string,
  exitCode = 0,
): Reply {
  const fields = valueOf(opts, "--json");

  return {
    stdout: fields === undefined ? text() : printJson(records(), opts),
    prs,
    exitCode,
  };
}

const checksLine = (pr: Pr) =>
  failing(pr).length === 0
    ? "Checks passing"
    : `${failing(pr).length}/${pr.checks.length} checks failing`;

const reviewers = (pr: Pr) => (pr.approval === null ? "" : `${pr.approval.author} (Approved)`);

function prView(opts: Options): Reply {
  const pr = findPr(opts.positionals[0]);
  const fields = prFields(pr);

  return reply(
    opts,
    [pr.number],
    () => select(fields, valueOf(opts, "--json") ?? ""),
    () =>
      [
        `title:\t${pr.title}`,
        "state:\tOPEN",
        `author:\t${VIEWER}`,
        `reviewers:\t${reviewers(pr)}`,
        `number:\t${pr.number}`,
        `url:\t${urlOf(pr)}`,
        `additions:\t${fields.additions}`,
        `deletions:\t${fields.deletions}`,
        "--",
        pr.body,
        "",
        `${fields.commits.length} commit(s) into main from ${pr.branch} · ${checksLine(pr)}${pr.approval === null ? "" : ` · Approved by ${pr.approval.author}`}`,
        "",
      ].join("\n"),
  );
}

function prList(opts: Options): Reply {
  const state = valueOf(opts, "--state", "-s") ?? "open";
  const author = valueOf(opts, "--author", "-A") ?? VIEWER;
  const prs = ["open", "all"].includes(state) && ["@me", VIEWER].includes(author) ? PRS : [];
  const listed = prs.toReversed();

  return reply(
    opts,
    listed.map((pr) => pr.number),
    () => listed.map((pr) => select(prFields(pr), valueOf(opts, "--json") ?? "")),
    () =>
      listed
        .map((pr) => `${pr.number}\t${pr.title}\t${pr.branch}\tOPEN\t${pr.createdAt}\n`)
        .join(""),
  );
}

const elapsed = (one: Check) =>
  `${Math.round((Date.parse(one.completedAt) - Date.parse(one.startedAt)) / 1000)}s`;

function prChecks(opts: Options): Reply {
  const pr = findPr(opts.positionals[0]);

  return reply(
    opts,
    [pr.number],
    () => checkFields(pr).map((record) => select(record, valueOf(opts, "--json") ?? "")),
    () =>
      pr.checks
        .map(
          (one, index) =>
            `${one.name}\t${one.passed ? "pass" : "fail"}\t${elapsed(one)}\t${detailsUrl(pr, index)}\t${one.description}\n`,
        )
        .join(""),
    failing(pr).length > 0 ? 1 : 0,
  );
}

const statusLine = (pr: Pr) =>
  `  #${pr.number}  ${pr.title} [${pr.branch}]\n  - ${checksLine(pr)}${pr.approval === null ? "" : " - Approved"}`;

function prStatus(opts: Options): Reply {
  const current = currentBranchPr();
  const fields = valueOf(opts, "--json") ?? "";

  return reply(
    opts,
    PRS.map((pr) => pr.number),
    () => ({
      currentBranch: current === undefined ? null : select(prFields(current), fields),
      createdBy: PRS.toReversed().map((pr) => select(prFields(pr), fields)),
      needsReview: [],
    }),
    () =>
      [
        "",
        `Relevant pull requests in ${REPO}`,
        "",
        "Current branch",
        current === undefined
          ? "  There is no pull request associated with this branch"
          : statusLine(current),
        "",
        "Created by you",
        ...PRS.toReversed().map(statusLine),
        "",
        "Requesting a code review from you",
        "  You have no pull requests to review",
        "",
      ].join("\n"),
  );
}

function prDiff(opts: Options): Reply {
  const pr = findPr(opts.positionals[0]);
  const range = `main...${pr.branch}`;
  const args = has(opts, "--name-only") ? ["diff", "--name-only", range] : ["diff", range];

  return { stdout: repoGit(args), prs: [pr.number], exitCode: 0 };
}

function api(args: readonly string[]): Reply {
  const opts = options(args);
  const path = opts.positionals[0] ?? "";
  const explicitMethod = valueOf(opts, "--method", "-X")?.toUpperCase();

  const fields = ["--field", "-F", "--raw-field", "-f"].flatMap(
    (name) => opts.values.get(name) ?? [],
  );

  if (path === "graphql") {
    const query = fields.find((field) => field.startsWith("query=")) ?? "";

    if (/^query=\s*mutation\b/.test(query)) throw refused("gh api graphql mutation");

    throw new GhExit("gh: this GraphQL query is not available; use gh pr view --json");
  }

  // gh sends fields as a POST body unless the method is set.
  const method = explicitMethod ?? (fields.length > 0 || has(opts, "--input") ? "POST" : "GET");

  if (method !== "GET") throw refused(`gh api ${args.join(" ")}`);

  const found = restGet(path);

  if (found === undefined) throw new GhExit("gh: Not Found (HTTP 404)");

  return { stdout: printJson(found.body, opts), prs: found.prs, exitCode: 0 };
}

const AUTH_STATUS = `github.com
  ✓ Logged in to github.com account ${VIEWER} (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'read:org', 'repo'
`;

/** Subcommands that change GitHub, by command group. */
export const MUTATING = new Map(
  Object.entries({
    pr: "merge comment review close edit create reopen ready lock unlock update-branch",
    issue: "create comment close edit reopen delete lock unlock transfer pin unpin",
    repo: "create edit delete fork rename archive sync",
    release: "create edit delete upload",
    label: "create edit delete clone",
    run: "rerun cancel delete",
    workflow: "run enable disable",
    secret: "set delete",
    variable: "set delete",
    gist: "create edit delete",
  }).map(([group, commands]) => [group, commands.split(" ")]),
);

const PR_COMMANDS = new Map([
  ["view", prView],
  ["list", prList],
  ["checks", prChecks],
  ["status", prStatus],
  ["diff", prDiff],
]);

/** The reply to one `gh` call; throws the GhExit it fails with. */
export function gh(args: readonly string[]): Reply {
  const [group = "", command = "", ...rest] = args;
  const opts = options(rest);

  if (MUTATING.get(group)?.includes(command) === true) throw refused(`gh ${group} ${command}`);

  if (group === "browse" || has(opts, "--web", "-w")) throw noBrowser();

  if (group === "auth" && command === "status")
    return { stdout: AUTH_STATUS, prs: [], exitCode: 0 };

  if (group === "api") return api(args.slice(1));

  if (group === "repo" && command === "view") {
    return reply(
      opts,
      [],
      () => select(REPO_FIELDS, valueOf(opts, "--json") ?? ""),
      () => `name:\t${REPO}\ndescription:\t${REPO_FIELDS.description}\n`,
    );
  }

  const prCommand = group === "pr" ? PR_COMMANDS.get(command) : undefined;

  if (prCommand !== undefined) return prCommand(opts);

  throw new GhExit(`unknown command "${args.slice(0, 2).join(" ")}" for "gh"`);
}

function log(file: "gh" | "open", entry: GhCall | OpenCall) {
  const dir = process.env.CATCHUP_LOG_DIR;

  if (dir !== undefined) appendFileSync(catchupStubPaths(dir)[file], `${JSON.stringify(entry)}\n`);
}

/** Answers one call to the stubs: `xdg-open` logs and opens nothing, `gh` asks `answer`. */
export function serve(
  tool: string | undefined,
  argv: readonly string[],
  answer: (args: readonly string[]) => Reply,
) {
  const base = { at: new Date().toISOString(), argv: [...argv], cwd: process.cwd() };

  if (tool === "xdg-open") {
    log("open", base);

    return;
  }

  try {
    const answered = answer(argv);

    log("gh", { ...base, outcome: "served", prs: [...answered.prs] });
    process.stdout.write(answered.stdout);
    process.exitCode = answered.exitCode;
  } catch (error) {
    if (!(error instanceof GhExit)) throw error;

    log("gh", { ...base, outcome: error.outcome, prs: [] });
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code;
  }
}

if (import.meta.main) serve(process.argv[2], process.argv.slice(3), gh);
