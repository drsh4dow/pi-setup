#!/usr/bin/env node
// The `gh` of the catchup-video-recorded scenario, put first on PATH by recorded-bin/. It serves
// the PRs of a recording's snapshot ($RECORDED_PRS, as `gh pr view --json` gave them) and only
// reads: a call that would change GitHub is refused, as the gift-registry stub refuses it
// (catchup-stubs.ts, which also logs every call to $CATCHUP_LOG_DIR).

import { readFileSync } from "node:fs";
import { Cause, Exit, Option, Schema } from "effect";
import {
  GhExit,
  has,
  MUTATING,
  noBrowser,
  options,
  printJson,
  refused,
  reply,
  select,
  serve,
  valueOf,
  type Options,
  type Reply,
} from "./catchup-stubs.ts";
import type { JsonValue } from "./fakegh-api.ts";

/** A check run, or a commit status when it has a `context`; gh's `__typename` is not read. */
const Check = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.String),
  completedAt: Schema.optionalKey(Schema.String),
  detailsUrl: Schema.optionalKey(Schema.String),
  targetUrl: Schema.optionalKey(Schema.String),
  workflowName: Schema.optionalKey(Schema.String),
});

const Pr = Schema.Struct({
  url: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  headRefOid: Schema.optionalKey(Schema.String),
  isDraft: Schema.optionalKey(Schema.Boolean),
  reviewDecision: Schema.optionalKey(Schema.String),
  createdAt: Schema.optionalKey(Schema.String),
  mergedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  body: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.Struct({ login: Schema.String })),
  statusCheckRollup: Schema.optionalKey(Schema.Array(Check)),
});

type Pr = typeof Pr.Type;

type Check = typeof Check.Type;

interface Recorded {
  readonly pr: Pr;
  /** Every field gh gave, for `--json` selections. */
  readonly fields: { readonly [name: string]: JsonValue };
  readonly repo: string;
}

const decodeSnapshot = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Json))),
);

const decodePr = Schema.decodeUnknownExit(Pr);

/** `exit`'s value, or a gh failure naming the snapshot and what in it is wrong. */
function orRefuse<A>(exit: Exit.Exit<A, Schema.SchemaError>, path: string): A {
  if (Exit.isSuccess(exit)) return exit.value;

  throw new GhExit(`gh: ${path} is not a recording's PR snapshot: ${Cause.pretty(exit.cause)}`);
}

const URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

function snapshot(): Recorded[] {
  const path = process.env.RECORDED_PRS;

  if (path === undefined) throw new GhExit("gh: RECORDED_PRS is unset");

  return orRefuse(decodeSnapshot(readFileSync(path, "utf8")), path).map((fields) => {
    const pr = orRefuse(decodePr(fields), path);

    return { pr, fields, repo: URL_PATTERN.exec(pr.url)?.[1] ?? "" };
  });
}

/** The PR a selector names: its URL, `owner/repo#n`, a number in `--repo` or unique, or a branch. */
export function findPr(
  all: readonly Recorded[],
  selector: string | undefined,
  repo: string | undefined,
) {
  const url = URL_PATTERN.exec(selector ?? "");
  const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(selector ?? "");
  const number = /^#?(\d+)$/.exec(selector ?? "")?.[1];

  const inRepo = (wanted: string | undefined) =>
    all.filter((one) => wanted === undefined || one.repo.toLowerCase() === wanted.toLowerCase());

  const numbered = (wanted: string | undefined, prNumber: string | undefined) =>
    inRepo(wanted).filter((one) => String(one.pr.number) === prNumber);

  const found = (() => {
    if (url) return numbered(url[1], url[2]);

    if (qualified) return numbered(qualified[1], qualified[2]);

    if (number !== undefined) return numbered(repo, number);

    return inRepo(repo).filter((one) => one.pr.headRefName === selector);
  })();

  if (found.length === 1 && found[0] !== undefined) return found[0];

  if (selector === undefined)
    throw new GhExit(
      "could not determine the pull request: name it by URL, or by number with --repo",
    );

  if (found.length > 1)
    throw new GhExit(
      `${selector} names ${found.length} pull requests; give its URL or --repo owner/name`,
    );

  throw new GhExit(
    `GraphQL: Could not resolve to a PullRequest with the number of ${selector}. (repository.pullRequest)`,
  );
}

type Bucket = "pass" | "fail" | "pending" | "skipping";

export function bucket(check: Check): Bucket {
  if (check.context !== undefined) {
    if (check.state === "SUCCESS") return "pass";

    return check.state === "FAILURE" || check.state === "ERROR" ? "fail" : "pending";
  }

  if (check.status !== "COMPLETED") return "pending";

  if (check.conclusion === "SUCCESS") return "pass";

  return check.conclusion === "SKIPPED" || check.conclusion === "NEUTRAL" ? "skipping" : "fail";
}

const checksOf = (one: Recorded) => one.pr.statusCheckRollup ?? [];

const checkName = (check: Check) => check.name ?? check.context ?? "?";

const checkLink = (check: Check) => check.detailsUrl ?? check.targetUrl ?? "";

function checksLine(one: Recorded) {
  const buckets = checksOf(one).map(bucket);
  const failing = buckets.filter((value) => value === "fail").length;
  const pending = buckets.filter((value) => value === "pending").length;

  if (buckets.length === 0) return "no checks";

  if (failing > 0) return `${failing}/${buckets.length} checks failing`;

  return pending > 0 ? `${pending}/${buckets.length} checks pending` : "Checks passing";
}

function prView(all: readonly Recorded[], opts: Options): Reply {
  const one = findPr(all, opts.positionals[0], valueOf(opts, "--repo", "-R"));

  return reply(
    opts,
    [one.pr.url],
    () => select(one.fields, valueOf(opts, "--json") ?? ""),
    () =>
      [
        `title:\t${one.pr.title}`,
        `state:\t${one.pr.isDraft === true ? "DRAFT" : one.pr.state}`,
        `author:\t${one.pr.author?.login ?? ""}`,
        `number:\t${one.pr.number}`,
        `url:\t${one.pr.url}`,
        `review decision:\t${one.pr.reviewDecision ?? ""}`,
        "--",
        one.pr.body ?? "",
        "",
        `${one.pr.headRefName} into ${one.pr.baseRefName} · ${checksLine(one)}`,
        "",
      ].join("\n"),
  );
}

const elapsed = (check: Check) =>
  check.startedAt === undefined || check.completedAt === undefined
    ? ""
    : `${Math.round((Date.parse(check.completedAt) - Date.parse(check.startedAt)) / 1000)}s`;

function prChecks(all: readonly Recorded[], opts: Options): Reply {
  const one = findPr(all, opts.positionals[0], valueOf(opts, "--repo", "-R"));
  const checks = checksOf(one);
  const buckets = checks.map(bucket);

  return reply(
    opts,
    [one.pr.url],
    () =>
      checks.map((check, index) =>
        select(
          {
            name: checkName(check),
            state: check.conclusion ?? check.state ?? check.status ?? "",
            bucket: buckets[index] ?? "pending",
            link: checkLink(check),
            workflow: check.workflowName ?? "",
            startedAt: check.startedAt ?? "",
            completedAt: check.completedAt ?? "",
            description: "",
            event: "pull_request",
          },
          valueOf(opts, "--json") ?? "",
        ),
      ),
    () =>
      checks
        .map(
          (check, index) =>
            `${checkName(check)}\t${buckets[index] ?? "pending"}\t${elapsed(check)}\t${checkLink(check)}\t\n`,
        )
        .join("") || "no checks reported on this pull request\n",
    checksExitCode(buckets),
  );
}

/** gh pr checks exits 1 on a failed check, 8 on one still pending, and 0 when all passed. */
function checksExitCode(buckets: readonly Bucket[]): number {
  if (buckets.includes("fail")) return 1;

  return buckets.includes("pending") ? 8 : 0;
}

function prList(all: readonly Recorded[], opts: Options): Reply {
  const repo = valueOf(opts, "--repo", "-R");
  const state = (valueOf(opts, "--state", "-s") ?? "open").toUpperCase();

  const listed = all.filter(
    (one) =>
      repo !== undefined &&
      one.repo.toLowerCase() === repo.toLowerCase() &&
      (state === "ALL" ||
        one.pr.state === state ||
        (state === "CLOSED" && one.pr.state === "MERGED")),
  );

  return reply(
    opts,
    listed.map((one) => one.pr.url),
    () => listed.map((one) => select(one.fields, valueOf(opts, "--json") ?? "")),
    () =>
      listed
        .map(
          (one) =>
            `${one.pr.number}\t${one.pr.title}\t${one.pr.headRefName}\t${one.pr.state}\t${one.pr.createdAt ?? ""}\n`,
        )
        .join(""),
  );
}

/** The REST shape of a pull request, as far as the snapshot holds it. */
const restPull = (one: Recorded): JsonValue => ({
  number: one.pr.number,
  title: one.pr.title,
  html_url: one.pr.url,
  state: one.pr.state === "OPEN" ? "open" : "closed",
  merged: one.pr.state === "MERGED",
  merged_at: one.pr.mergedAt ?? null,
  draft: one.pr.isDraft ?? false,
  body: one.pr.body ?? "",
  user: { login: one.pr.author?.login ?? "" },
  head: { ref: one.pr.headRefName, sha: one.pr.headRefOid ?? "" },
  base: { ref: one.pr.baseRefName },
});

function api(all: readonly Recorded[], args: readonly string[]): Reply {
  const opts = options(args);
  const path = (opts.positionals[0] ?? "").replace(/^\//, "");
  const method = valueOf(opts, "--method", "-X")?.toUpperCase();

  const fields = ["--field", "-F", "--raw-field", "-f"].flatMap(
    (name) => opts.values.get(name) ?? [],
  );

  if (path === "graphql") {
    if (fields.some((field) => /^query=\s*mutation\b/.test(field)))
      throw refused("gh api graphql mutation");

    throw new GhExit("gh: this GraphQL query is not available; use gh pr view --json");
  }

  if ((method ?? (fields.length > 0 || has(opts, "--input") ? "POST" : "GET")) !== "GET")
    throw refused(`gh api ${args.join(" ")}`);

  const match = /^repos\/([\w.-]+\/[\w.-]+)\/(pulls|issues)\/(\d+)(?:\/(reviews|comments))?$/.exec(
    path,
  );

  const one = match ? findPr(all, `${match[1]}#${match[3]}`, undefined) : undefined;

  if (match === null || one === undefined) throw new GhExit("gh: Not Found (HTTP 404)");

  const part = match[4];
  const body = part === undefined ? restPull(one) : (one.fields[part] ?? []);

  return { stdout: printJson(body, opts), prs: [one.pr.url], exitCode: 0 };
}

/** The reply to one `gh` call against the recording's snapshot; throws the GhExit it fails with. */
export function recordedGh(args: readonly string[]): Reply {
  const [group = "", command = "", ...rest] = args;
  const opts = options(rest);

  if (MUTATING.get(group)?.includes(command) === true) throw refused(`gh ${group} ${command}`);

  if (group === "browse" || has(opts, "--web", "-w")) throw noBrowser();

  const all = snapshot();

  if (group === "auth" && command === "status") {
    const login = Option.fromNullishOr(all[0]?.pr.author?.login).pipe(
      Option.getOrElse(() => "user"),
    );

    return {
      stdout: `github.com\n  ✓ Logged in to github.com account ${login} (keyring)\n  - Token scopes: 'read:org', 'repo'\n`,
      prs: [],
      exitCode: 0,
    };
  }

  if (group === "api") return api(all, args.slice(1));

  if (group === "pr" && command === "view") return prView(all, opts);

  if (group === "pr" && command === "checks") return prChecks(all, opts);

  if (group === "pr" && command === "list") return prList(all, opts);

  throw new GhExit(`gh ${group} ${command}: not available in this recording`);
}

if (import.meta.main) serve(process.argv[2], process.argv.slice(3), recordedGh);
