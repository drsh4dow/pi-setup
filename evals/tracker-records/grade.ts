#!/usr/bin/env node
// Grades to-spec and to-tickets runs from what reached faketrack: its call log and the issues it
// holds after the run. A skill that bypassed the record, such as by calling gh, leaves nothing
// here and fails.
//
//   node evals/tracker-records/grade.ts <results-dir>

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { gitOutput } from "../lib/pi-run.ts";

export const TrackerRunRecord = Schema.Struct({
  skill: Schema.Literals(["to-spec", "to-tickets"]),
  model: Schema.String,
  trial: Schema.Int,
  workdir: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  durationMs: Schema.Int,
  session: Schema.NullOr(Schema.String),
});

export type TrackerRunRecord = typeof TrackerRunRecord.Type;

const Issue = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  labels: Schema.Array(Schema.String),
  parent: Schema.NullOr(Schema.Int),
  blockedBy: Schema.Array(Schema.Int),
  comments: Schema.Array(Schema.String),
  closed: Schema.Boolean,
});

export type Issue = typeof Issue.Type;

const State = Schema.Struct({ issues: Schema.Array(Issue) });

const Call = Schema.Struct({
  command: Schema.String,
  positionals: Schema.Array(Schema.String),
});

export type Call = typeof Call.Type;

const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(TrackerRunRecord));

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(State));

const decodeCall = Schema.decodeUnknownSync(Schema.fromJsonString(Call));

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail?: string;
}

/** Files a run may change: the domain docs ask for new terms to be added to the glossary. */
const MAY_CHANGE = new Set(["GLOSSARY.md"]);

function changedFiles(workdir: string): string[] {
  const tracked = gitOutput(workdir, ["diff", "--name-only", "HEAD"]);
  const untracked = gitOutput(workdir, ["ls-files", "--others", "--exclude-standard"]);

  return `${tracked}\n${untracked}`.split("\n").filter((path) => path !== "");
}

/** The setup has no triage labels, so nothing the skills publish carries one. */
const unlabelled = (issues: readonly Issue[]) => issues.every((issue) => issue.labels.length === 0);

/** The sections of to-spec's template that every spec fills; Further Notes is optional. */
const SPEC_SECTIONS = [
  "Problem Statement",
  "Solution",
  "User Stories",
  "Implementation Decisions",
  "Testing Decisions",
  "Out of Scope",
];

const CHECK_BODY = join(
  dirname(new URL(import.meta.url).pathname),
  "../../agent/skills/writing-good-prs/scripts/check-body.ts",
);

/**
 * Runs writing-good-tickets' body check, the gate to-tickets must pass before publishing, and
 * returns the problems it prints, empty when the ticket passes.
 */
export function ticketBodyProblems(ticket: Issue): string[] {
  const dir = mkdtempSync(join(tmpdir(), "ticket-body-"));
  const file = join(dir, "body.md");

  try {
    writeFileSync(file, ticket.body);

    const result = spawnSync(
      process.execPath,
      [CHECK_BODY, "ticket", file, "--title", ticket.title],
      { encoding: "utf8" },
    );

    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`check-body exited ${result.status}: ${result.stderr}`);
    }

    return result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => `#${ticket.id} ${line.replace(`${file}:`, "line ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function checkToSpec(issues: readonly Issue[]): Check[] {
  const [spec] = issues;
  const headings = new Set(spec?.body.match(/^## .+$/gm)?.map((line) => line.slice(3).trim()));
  const missing = SPEC_SECTIONS.filter((section) => !headings.has(section));

  return [
    { name: "publishes exactly one spec", pass: issues.length === 1, detail: `${issues.length}` },
    { name: "applies no label", pass: unlabelled(issues), detail: spec?.labels.join(", ") },
    {
      name: "fills the spec template",
      pass: spec !== undefined && missing.length === 0,
      detail: missing.length > 0 ? `missing ${missing.join(", ")}` : undefined,
    },
  ];
}

export function checkToTickets(issues: readonly Issue[], calls: readonly Call[]): Check[] {
  const [parent, ...tickets] = issues;
  const edges = tickets.flatMap((ticket) => ticket.blockedBy.map((by) => [by, ticket.id]));
  const bodyProblems = tickets.flatMap(ticketBodyProblems);

  const parentTouched = calls.some(
    ({ command, positionals }) =>
      ["comment", "label", "close"].includes(command) && positionals[0]?.replace("#", "") === "1",
  );

  return [
    {
      name: "fetches the source issue",
      pass: calls.some(
        ({ command, positionals }) =>
          command === "view" && positionals[0]?.replace("#", "") === "1",
      ),
    },
    {
      name: "publishes at least two tickets",
      pass: tickets.length >= 2,
      detail: `${tickets.length}`,
    },
    {
      name: "nests every ticket under #1",
      pass: tickets.length > 0 && tickets.every((ticket) => ticket.parent === 1),
    },
    { name: "applies no label", pass: unlabelled(issues) },
    {
      name: "passes writing-good-tickets' body check",
      pass: tickets.length > 0 && bodyProblems.length === 0,
      detail: bodyProblems.slice(0, 3).join("; ") || undefined,
    },
    {
      name: "records at least one blocking edge",
      pass: edges.length >= 1,
      detail: `${edges.length}`,
    },
    {
      name: "publishes blockers before what they block",
      pass: edges.every(([blocker, blocked]) => blocker < blocked && blocker !== 1),
    },
    { name: "leaves the parent issue alone", pass: !parentTouched && !parent?.closed },
  ];
}

function grade(resultsDir: string) {
  const runs = readdirSync(resultsDir, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith("run.json"))
    .toSorted();

  let failed = 0;

  for (const path of runs) {
    const dir = join(resultsDir, dirname(path));
    const record = decodeRecord(readFileSync(join(dir, "run.json"), "utf8"));
    const { issues } = decodeState(readFileSync(join(dir, "faketrack-state.json"), "utf8"));

    const calls = readFileSync(join(dir, "faketrack-log.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => decodeCall(line));

    const unexpected = changedFiles(record.workdir).filter((file) => !MAY_CHANGE.has(file));

    const commits = Number(gitOutput(record.workdir, ["rev-list", "--count", "--all"]));

    if (commits > 1) unexpected.push(`${commits - 1} new commits`);

    const checks: Check[] = [
      { name: "exits 0", pass: record.exitCode === 0 && !record.timedOut },
      {
        name: "changes no repository file but the glossary",
        pass: unexpected.length === 0,
        detail: unexpected.join(", ") || undefined,
      },
      ...(record.skill === "to-spec" ? checkToSpec(issues) : checkToTickets(issues, calls)),
    ];

    console.log(`\n${record.skill} ${record.model} t${record.trial} (${dir})`);

    for (const { name, pass, detail } of checks) {
      console.log(`  ${pass ? "pass" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);

      if (!pass) failed += 1;
    }
  }

  console.log(`\n${runs.length} runs, ${failed} failed checks`);

  if (failed > 0) process.exitCode = 1;
}

if (import.meta.main) {
  const dir = process.argv[2];

  if (!dir) {
    console.error("usage: node evals/tracker-records/grade.ts <results-dir>");
    process.exit(2);
  }

  grade(dir);
}
