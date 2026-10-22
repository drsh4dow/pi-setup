#!/usr/bin/env node
// Grades setup-sh4dow-skills runs by reading the config record each run left in its working
// directory. Every check reads a real file or git state; none reads the transcript.
//
//   node evals/setup-sh4dow-skills/grade.ts <results-dir>

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { gitOutput } from "../lib/pi-run.ts";
import { scenarios, type Scenario } from "./scenarios.ts";

export const PassRecord = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  durationMs: Schema.Int,
  session: Schema.NullOr(Schema.String),
  /** Files changed plus commits added by this pass. */
  changes: Schema.Int,
});

export type PassRecord = typeof PassRecord.Type;

export const SetupRunRecord = Schema.Struct({
  fixture: Schema.String,
  model: Schema.String,
  trial: Schema.Int,
  workdir: Schema.String,
  first: PassRecord,
  second: PassRecord,
});

export type SetupRunRecord = typeof SetupRunRecord.Type;

const decodeSetupRunRecord = Schema.decodeUnknownSync(Schema.fromJsonString(SetupRunRecord));

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail?: string;
}

function read(workdir: string, path: string): string | undefined {
  const file = join(workdir, path);

  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function filesMatching(workdir: string, pattern: RegExp): string {
  return readdirSync(workdir, { recursive: true })
    .map(String)
    .filter((path) => !path.startsWith(".git/") && pattern.test(path))
    .map((path) => readFileSync(join(workdir, path), "utf8"))
    .join("\n");
}

/** Glossary terms are bold lines ending in a colon, per the domain-modeling glossary format. */
export function glossaryTerms(glossary: string): string[] {
  return [...glossary.matchAll(/^\*\*(.+?)\*\*:/gm)].map((match) => match[1]);
}

export function checkWorkdir(workdir: string, scenario: Scenario): Check[] {
  const checks: Check[] = [];

  const check = (name: string, pass: boolean, detail?: string) =>
    checks.push({ name, pass, detail });

  const other = scenario.agentFile === "AGENTS.md" ? "CLAUDE.md" : "AGENTS.md";
  const agentFile = read(workdir, scenario.agentFile) ?? "";
  const blocks = agentFile.match(/^## Agent skills\s*$/gm)?.length ?? 0;

  check(`edits ${scenario.agentFile}, one Agent skills block`, blocks === 1, `${blocks} blocks`);
  check(`leaves no ${other} beside it`, read(workdir, other) === undefined);

  if (scenario.folded) {
    check(`folds "${scenario.folded}" into the record`, !agentFile.includes(scenario.folded));
  }

  const tracker = read(workdir, "docs/agents/issue-tracker.md") ?? "";

  check(`issue tracker matches ${scenario.tracker}`, scenario.tracker.test(tracker));

  check(
    "writes no triage label record",
    read(workdir, "docs/agents/triage-labels.md") === undefined,
  );

  check("writes domain docs", read(workdir, "docs/agents/domain.md") !== undefined);

  const standards = read(workdir, "docs/agents/standards.md");
  const missing = scenario.standards.filter((needle) => !standards?.includes(needle));

  check(
    "records standards and guardrails",
    standards !== undefined && missing.length === 0,
    missing.length > 0 ? `missing ${missing.join(", ")}` : undefined,
  );

  if (scenario.glossary) {
    // A multi-context layout keeps one GLOSSARY.md per context, so read them all.
    const terms = glossaryTerms(filesMatching(workdir, /(^|\/)GLOSSARY\.md$/));
    const code = filesMatching(workdir, /\.(ts|js|py|go|rs)$/).toLowerCase();
    const grounded = terms.filter((term) => code.includes(term.toLowerCase().split(/\s+/)[0]));

    check(
      "seeds a glossary of at least 3 terms found in the code",
      grounded.length >= 3,
      `${grounded.length}/${terms.length} grounded`,
    );
  }

  return checks;
}

function grade(resultsDir: string) {
  const runs = readdirSync(resultsDir, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith("run.json"));

  let failed = 0;

  for (const path of runs.toSorted()) {
    const record = decodeSetupRunRecord(readFileSync(join(resultsDir, path), "utf8"));
    const scenario = scenarios.find((candidate) => candidate.fixture === record.fixture);

    if (!scenario) continue;

    const dirty = gitOutput(record.workdir, ["status", "--porcelain"]) !== "";

    const checks: Check[] = [
      { name: "first pass exits 0", pass: record.first.exitCode === 0 && !record.first.timedOut },
      { name: "first pass commits its record", pass: record.first.changes > 0 && !dirty },
      {
        name: "rerun changes nothing",
        pass: record.second.exitCode === 0 && record.second.changes === 0,
        detail: `${record.second.changes} changes`,
      },
      ...checkWorkdir(record.workdir, scenario),
    ];

    console.log(`\n${record.fixture} ${record.model} t${record.trial} (${record.workdir})`);

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
    console.error("usage: node evals/setup-sh4dow-skills/grade.ts <results-dir>");
    process.exit(2);
  }

  grade(dir);
}
