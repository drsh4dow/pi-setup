// `gh pr`: the pull request subcommands of the fake `gh`, and the flag parsing the other
// subcommands share.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { mergeMethodOf } from "./gh-api.ts";
import { diff } from "./gh-git.ts";
import {
  closePr,
  commentOnPr,
  createPr,
  editPr,
  fail,
  mergePr,
  readyPr,
  requirePr,
  reviewPr,
  type Context,
  type Outcome,
} from "./gh-ops.ts";
import type { FakeGitHub, PullRequest } from "./gh-state.ts";
import { checkNodes, ciStatus, json, prFields, prText } from "./gh-views.ts";
import type { JsonValue } from "./json.ts";

export function pick(all: Readonly<Record<string, JsonValue>>, fields: string) {
  const wanted = fields.split(",").map((name) => name.trim());
  const unknown = wanted.find((name) => !Object.hasOwn(all, name));

  if (unknown !== undefined)
    fail(`Unknown JSON field: "${unknown}"\nAvailable fields:\n  ${Object.keys(all).join("\n  ")}`);

  return Object.fromEntries(Object.entries(all).filter(([name]) => wanted.includes(name)));
}

function currentBranch(): string {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });

  if (result.status !== 0) fail("could not determine current branch: not a git repository");

  return result.stdout.trim();
}

/** The PR a selector names: a number, a URL, a branch, or by default the current branch's. */
function selectPr(state: FakeGitHub, selector: string | undefined): PullRequest {
  const raw = selector ?? currentBranch();
  const number = /^#?(\d+)$/.exec(raw)?.[1] ?? /\/pull\/(\d+)/.exec(raw)?.[1];

  if (number !== undefined) return requirePr(state, Number(number));

  const byBranch = state.prs.findLast((pr) => pr.headRefName === raw);

  return byBranch ?? fail(`no pull requests found for branch "${raw}"`);
}

function checkRows(state: FakeGitHub, pr: PullRequest) {
  const status = ciStatus(state, pr);
  const node = checkNodes(state, pr)[0];

  return [
    {
      name: node.name,
      state: { pending: "IN_PROGRESS", passed: "SUCCESS", failed: "FAILURE" }[status],
      bucket: { pending: "pending", passed: "pass", failed: "fail" }[status],
      description: "",
      link: node.detailsUrl,
      workflow: "CI",
      event: "pull_request",
      startedAt: node.startedAt,
      completedAt: node.completedAt,
    },
  ];
}

/** gh exits 8 while checks are pending and 1 when one failed. */
function checksOutcome(state: FakeGitHub, pr: PullRequest, fields: string | undefined): Outcome {
  const status = ciStatus(state, pr);
  const rows = checkRows(state, pr);
  const exitCode = { pending: 8, passed: 0, failed: 1 }[status];

  const text =
    fields === undefined
      ? `${rows.map((row) => `${row.name}\t${row.bucket}\t${row.link}`).join("\n")}\n`
      : json(rows.map((row) => pick(row, fields)));

  return { stdout: text, state, change: null, exitCode };
}

/** What `parseArgs` with `strict: false` yields for one flag. */
type FlagValue = string | boolean | (string | boolean)[] | undefined;

export type Flags = Readonly<Partial<Record<string, FlagValue>>>;

const isString = Schema.is(Schema.String);

export function stringOf(values: Flags, name: string): string | undefined {
  const value = values[name];

  return isString(value) ? value : undefined;
}

/** Every string a repeatable flag was given. */
export function stringsOf(values: Flags, name: string): string[] {
  const value = values[name];

  if (Array.isArray(value)) return value.filter(isString);

  return isString(value) ? [value] : [];
}

function bodyOf(values: Flags): string | undefined {
  const body = stringOf(values, "body");

  if (body !== undefined) return body;

  const file = stringOf(values, "body-file");

  return file === undefined ? undefined : readFileSync(file === "-" ? 0 : file, "utf8");
}

type OptionSpec = { readonly type: "string" | "boolean"; readonly short?: string };

const COMMON_OPTIONS = {
  json: { type: "string" },
  jq: { type: "string", short: "q" },
  repo: { type: "string", short: "R" },
  comments: { type: "boolean" },
  body: { type: "string", short: "b" },
  "body-file": { type: "string", short: "F" },
  title: { type: "string", short: "t" },
  base: { type: "string", short: "B" },
  head: { type: "string", short: "H" },
  limit: { type: "string", short: "L" },
  undo: { type: "boolean" },
  auto: { type: "boolean" },
  admin: { type: "boolean" },
  "name-only": { type: "boolean" },
  watch: { type: "boolean" },
  fill: { type: "boolean", short: "f" },
} as const satisfies Readonly<Record<string, OptionSpec>>;

// gh reuses short flags across subcommands with different meanings, so each declares its own.
const SUBCOMMAND_OPTIONS = new Map<string, Readonly<Record<string, OptionSpec>>>(
  Object.entries<Readonly<Record<string, OptionSpec>>>({
    list: { state: { type: "string", short: "s" } },
    create: { draft: { type: "boolean", short: "d" } },
    merge: {
      merge: { type: "boolean", short: "m" },
      squash: { type: "boolean", short: "s" },
      rebase: { type: "boolean", short: "r" },
      "delete-branch": { type: "boolean", short: "d" },
      subject: { type: "string", short: "t" },
    },
    review: {
      approve: { type: "boolean", short: "a" },
      comment: { type: "boolean", short: "c" },
      "request-changes": { type: "boolean", short: "r" },
    },
    close: {
      comment: { type: "string", short: "c" },
      "delete-branch": { type: "boolean", short: "d" },
    },
  } as const satisfies Readonly<Record<string, Readonly<Record<string, OptionSpec>>>>),
);

function checkRepo(state: FakeGitHub, repo: string | undefined) {
  if (repo === undefined) return;

  const name = repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");

  if (name !== `${state.owner}/${state.repo}`)
    fail(`GraphQL: Could not resolve to a Repository with the name '${name}'. (repository)`);
}

function reviewEvent(values: Flags): "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" {
  if (values.approve === true) return "APPROVED";

  return values["request-changes"] === true ? "CHANGES_REQUESTED" : "COMMENTED";
}

export function prCommand(
  state: FakeGitHub,
  sub: string | undefined,
  args: readonly string[],
  context: Context,
): Outcome {
  const options = { ...COMMON_OPTIONS, ...SUBCOMMAND_OPTIONS.get(sub ?? "") };

  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options,
  });

  const read = (stdout: string): Outcome => ({ stdout, state, change: null });
  const fields = stringOf(values, "json");

  checkRepo(state, stringOf(values, "repo"));

  switch (sub ?? "") {
    case "create":
      return createPr(
        state,
        {
          base: stringOf(values, "base") ?? state.defaultBranch,
          head: stringOf(values, "head") ?? currentBranch(),
          title:
            stringOf(values, "title") ??
            fail(
              "must provide `--title` and `--body` (or `--fill`) when not running interactively",
            ),
          body:
            bodyOf(values) ??
            fail(
              "must provide `--title` and `--body` (or `--fill`) when not running interactively",
            ),
          draft: values.draft === true,
        },
        context,
      );

    case "view": {
      const pr = selectPr(state, positionals[0]);

      return read(
        fields === undefined
          ? prText(state, pr, values.comments === true)
          : json(pick(prFields(state, pr), fields)),
      );
    }

    case "list": {
      const wanted = stringOf(values, "state") ?? "open";
      const limit = Number(stringOf(values, "limit") ?? 30);

      const prs = state.prs
        .filter((pr) => wanted === "all" || pr.state === wanted.toUpperCase())
        .filter(
          (pr) =>
            stringOf(values, "base") === undefined || pr.baseRefName === stringOf(values, "base"),
        )
        .filter(
          (pr) =>
            stringOf(values, "head") === undefined || pr.headRefName === stringOf(values, "head"),
        )
        .toReversed()
        .slice(0, limit);

      if (fields !== undefined)
        return read(json(prs.map((pr) => pick(prFields(state, pr), fields))));

      return read(
        prs.map((pr) => `${pr.number}\t${pr.title}\t${pr.headRefName}\t${pr.state}`).join("\n") +
          (prs.length > 0 ? "\n" : ""),
      );
    }

    case "edit": {
      const pr = selectPr(state, positionals[0]);

      return editPr(state, pr.number, {
        title: stringOf(values, "title"),
        body: bodyOf(values),
        base: stringOf(values, "base"),
      });
    }

    case "checks":
      return checksOutcome(state, selectPr(state, positionals[0]), fields);

    case "merge": {
      const pr = selectPr(state, positionals[0]);

      if (values.auto === true)
        fail(`GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)`);

      const methods = (["merge", "squash", "rebase"] as const).filter(
        (method) => values[method] === true,
      );

      if (methods.length !== 1)
        fail("--merge, --rebase, or --squash required when not running interactively");

      return mergePr(
        state,
        pr.number,
        { method: mergeMethodOf(methods[0]), deleteBranch: values["delete-branch"] === true },
        context,
      );
    }

    case "close": {
      const pr = selectPr(state, positionals[0]);
      const comment = stringOf(values, "comment");

      const closed = closePr(
        state,
        pr.number,
        { deleteBranch: values["delete-branch"] === true },
        context,
      );

      return comment === undefined
        ? closed
        : {
            ...closed,
            state: commentOnPr(closed.state, pr.number, comment, context).outcome.state,
          };
    }

    case "ready":
      return readyPr(state, selectPr(state, positionals[0]).number, values.undo === true);

    case "comment": {
      const body = bodyOf(values) ?? fail("gh pr comment: --body or --body-file is required");

      return commentOnPr(state, selectPr(state, positionals[0]).number, body, context).outcome;
    }

    case "review": {
      const pr = selectPr(state, positionals[0]);

      return reviewPr(
        state,
        pr.number,
        { event: reviewEvent(values), body: bodyOf(values) ?? "" },
        context,
      );
    }

    case "diff": {
      const pr = selectPr(state, positionals[0]);

      return read(
        `${diff(state.bare, pr.baseRefName, pr.headRefOid, values["name-only"] === true)}\n`,
      );
    }

    case "status": {
      const mine = state.prs.filter((pr) => pr.state === "OPEN");

      return read(
        `Created by you\n${mine.map((pr) => `  #${pr.number}  ${pr.title} [${pr.headRefName}]  checks: ${ciStatus(state, pr)}`).join("\n")}\n`,
      );
    }

    default:
      return fail(`unknown command "${sub ?? ""}" for "gh pr"`);
  }
}
