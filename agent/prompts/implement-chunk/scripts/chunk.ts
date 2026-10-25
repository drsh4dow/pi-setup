#!/usr/bin/env node

// The implement-chunk lead's bookkeeping CLI: it writes units.tsv and ledger.tsv in the state
// folder and prints the merge-ready report from them and the live PRs.
//
// Exit codes: 0 clean, 1 a violation (not merge-ready, trees differ), 2 could not run or
// refused input.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Outcomes, parseOutcomes } from "./outcomes.ts";
import {
  PR_VIEW_FIELDS,
  type PrRef,
  decodePrView,
  formatPrRef,
  parsePrRef,
} from "./pull-request.ts";
import { type Lookup, renderReport, ticketsOf } from "./report.ts";
import {
  LEDGER_COLUMNS,
  UNIT_COLUMNS,
  type Verdict,
  isUnitColumn,
  parseLedger,
  parseUnits,
} from "./state.ts";
import { Refusal, tsvLine } from "./tsv.ts";

const USAGE = `Usage: chunk.ts --state <dir> <command>

  ledger record <pr> <sha> <outcome> <evidence>
  ledger carry <pr> <new-sha> <from-sha> [-C <repo-dir>]
  unit add <id> <column>=<value>...
  unit set <id> <column>=<value>...
  report

The state folder comes from --state, else $IMPLEMENT_CHUNK_STATE.
Outcomes come from the Ledger outcomes table in implement-chunk/brief.md.
Exit codes: 0 clean, 1 a violation, 2 could not run or refused input.`;

const BRIEF = fileURLToPath(new URL("../brief.md", import.meta.url));

interface Result {
  readonly out: string;
  readonly exit: number;
}

function readOutcomes(): Outcomes {
  return parseOutcomes(BRIEF, readFileSync(BRIEF, "utf8"));
}

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function fullSha(text: string): string {
  if (!/^[0-9a-f]{40}$/.test(text)) throw new Refusal(`not a full 40-character SHA: ${text}`);

  return text;
}

function prArgument(text: string): PrRef {
  const ref = parsePrRef(text);

  if (ref === null) throw new Refusal(`not a PR (12, #12, owner/repo#12, or URL): ${text}`);

  return ref;
}

function ledgerRows(path: string): Verdict[] {
  const text = readIfPresent(path);

  return text === null ? [] : parseLedger(path, text);
}

function appendVerdict(path: string, cells: readonly string[]): Result {
  const line = tsvLine([...cells, new Date().toISOString()]);
  const existing = readIfPresent(path);

  if (existing === null) writeFileSync(path, `${LEDGER_COLUMNS.join("\t")}\n`);

  appendFileSync(path, `${line}\n`);

  const number = ledgerRows(path).length + 1;

  return { out: `${path}:${number}: ${cells.slice(0, 3).join(" ")}`, exit: 0 };
}

function recordVerdict(path: string, args: readonly string[]): Result {
  const [prText = "", shaText = "", outcome = "", evidence = "", ...extra] = args;

  if (extra.length > 0 || evidence === "") {
    throw new Refusal("ledger record takes <pr> <sha> <outcome> <evidence>");
  }

  const pr = formatPrRef(prArgument(prText));
  const sha = fullSha(shaText);
  const outcomes = readOutcomes();

  ledgerRows(path);

  if (!outcomes.has(outcome)) {
    throw new Refusal(
      `"${outcome}" is not a Ledger outcome in ${BRIEF}; refused this line:\n` +
        `${[pr, sha, outcome, evidence].join("\t")}\n` +
        `Ledger outcomes: ${[...outcomes.keys()].join(", ")}`,
    );
  }

  return appendVerdict(path, [pr, sha, outcome, evidence]);
}

function treeOf(repoDir: string, sha: string): string {
  const git = spawnSync("git", ["-C", repoDir, "rev-parse", "--verify", `${sha}^{tree}`], {
    encoding: "utf8",
  });

  if (git.status !== 0) {
    throw new Refusal(`git rev-parse ${sha}^{tree} in ${repoDir} failed: ${git.stderr.trim()}`);
  }

  return git.stdout.trim();
}

function carryVerdict(path: string, args: readonly string[], repoDir: string): Result {
  const [prText = "", newText = "", fromText = "", ...extra] = args;

  if (extra.length > 0 || fromText === "") {
    throw new Refusal("ledger carry takes <pr> <new-sha> <from-sha>");
  }

  const pr = prArgument(prText);
  const newSha = fullSha(newText);
  const fromSha = fullSha(fromText);
  const rows = ledgerRows(path);

  const from =
    rows.findLast((row) => row.sha === fromSha && formatPrRef(row.pr) === formatPrRef(pr)) ??
    rows.findLast((row) => row.sha === fromSha);

  if (from === undefined) throw new Refusal(`${path}: no verdict at ${fromSha} to carry`);

  const fromTree = treeOf(repoDir, fromSha);
  const newTree = treeOf(repoDir, newSha);

  if (fromTree !== newTree) {
    return {
      out: `trees differ: ${fromSha} has tree ${fromTree}, ${newSha} has ${newTree}; record a fresh verdict`,
      exit: 1,
    };
  }

  return appendVerdict(path, [formatPrRef(pr), newSha, from.outcome, `carried from ${fromSha}`]);
}

function columnValues(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();

  for (const arg of args) {
    const split = arg.indexOf("=");
    const column = split === -1 ? arg : arg.slice(0, split);

    if (split === -1 || !isUnitColumn(column) || column === "id") {
      throw new Refusal(
        `not <column>=<value> with a units.tsv column: ${arg}\n` +
          `columns: ${UNIT_COLUMNS.slice(1).join(", ")}`,
      );
    }

    if (values.has(column)) throw new Refusal(`column given twice: ${column}`);

    values.set(column, arg.slice(split + 1));
  }

  return values;
}

function writeUnit(path: string, mode: string, args: readonly string[]): Result {
  const [id = "", ...assignments] = args;

  if (id === "" || (mode === "set" && assignments.length === 0)) {
    throw new Refusal(`unit ${mode} takes <id> <column>=<value>...`);
  }

  const values = columnValues(assignments);
  const text = readIfPresent(path);
  const rows = text === null ? [] : parseUnits(path, text);
  const lines = rows.map((row) => row.cells.slice());
  const existing = lines.find((cells) => cells[0] === id);

  if (mode === "add" && existing !== undefined) throw new Refusal(`${path}: unit ${id} exists`);

  if (mode === "set" && existing === undefined) throw new Refusal(`${path}: no unit ${id}`);

  const cells = existing ?? UNIT_COLUMNS.map((column) => (column === "id" ? id : ""));

  if (existing === undefined) lines.push(cells);

  for (const [column, value] of values) {
    cells[UNIT_COLUMNS.findIndex((name) => name === column)] = value;
  }

  const body = [UNIT_COLUMNS, ...lines].map((line) => `${tsvLine(line)}\n`).join("");
  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, body);
  renameSync(temporary, path);

  const filled = UNIT_COLUMNS.flatMap((column, index) =>
    cells[index] ? [`${column}=${cells[index]}`] : [],
  );

  return { out: `${path}: ${mode} ${filled.join(" ")}`, exit: 0 };
}

function lookupPr(ref: PrRef): Lookup {
  const repo = ref.repo === null ? [] : ["-R", ref.repo];

  const gh = spawnSync(
    "gh",
    ["pr", "view", String(ref.number), "--json", PR_VIEW_FIELDS.join(","), ...repo],
    { encoding: "utf8" },
  );

  if (gh.error !== undefined) return { kind: "failed", message: `gh: ${gh.error.message}` };

  if (gh.status !== 0) {
    return { kind: "failed", message: `gh pr view ${formatPrRef(ref)}: ${gh.stderr.trim()}` };
  }

  try {
    return { kind: "found", view: decodePrView(gh.stdout) };
  } catch (error) {
    return { kind: "failed", message: `gh pr view ${formatPrRef(ref)}: ${String(error)}` };
  }
}

function report(state: string): Result {
  const unitsPath = join(state, "units.tsv");
  const unitsText = readIfPresent(unitsPath);

  if (unitsText === null) throw new Refusal(`${unitsPath}: missing`);

  const tickets = ticketsOf(parseUnits(unitsPath, unitsText));

  if (tickets.length === 0) throw new Refusal(`${unitsPath}: no unit names a ticket`);

  const ledgerPath = join(state, "ledger.tsv");
  const lookups = new Map<string, Lookup>();

  const { text, exit } = renderReport({
    tickets,
    ledger: ledgerRows(ledgerPath),
    ledgerFile: ledgerPath,
    outcomes: readOutcomes(),
    outcomesFile: BRIEF,
    lookup: (ref) => {
      const key = formatPrRef(ref);
      const cached = lookups.get(key) ?? lookupPr(ref);

      lookups.set(key, cached);

      return cached;
    },
  });

  return { out: text, exit };
}

function run(argv: readonly string[]): Result {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      state: { type: "string" },
      "repo-dir": { type: "string", short: "C" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help === true) return { out: USAGE, exit: 0 };

  const state = values.state ?? process.env.IMPLEMENT_CHUNK_STATE;

  if (state === undefined || state === "") throw new Refusal("no state folder: pass --state <dir>");

  if (!existsSync(state)) throw new Refusal(`state folder missing: ${state}`);

  const [group = "", command = "", ...args] = positionals;
  const ledgerPath = join(state, "ledger.tsv");

  if (group === "ledger" && command === "record") return recordVerdict(ledgerPath, args);

  if (group === "ledger" && command === "carry") {
    return carryVerdict(ledgerPath, args, values["repo-dir"] ?? process.cwd());
  }

  if (group === "unit" && (command === "add" || command === "set")) {
    return writeUnit(join(state, "units.tsv"), command, args);
  }

  if (group === "report" && command === "") return report(state);

  throw new Refusal(`unknown command: ${positionals.join(" ") || "none"}\n\n${USAGE}`);
}

function main(): number {
  try {
    const { out, exit } = run(process.argv.slice(2));

    process.stdout.write(`${out}\n`);

    return exit;
  } catch (error) {
    // Any failure here, a refusal, a bad flag, or an unreadable file, means the command could
    // not run. It must not exit 1, which callers read as a violation.
    const message = error instanceof Error ? error.message : String(error);
    const usage = error instanceof Refusal ? "" : `\n\n${USAGE}`;

    process.stderr.write(`refused: ${message}${usage}\n`);

    return 2;
  }
}

process.exitCode = main();
