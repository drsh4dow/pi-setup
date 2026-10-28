#!/usr/bin/env node

// The implement-chunk lead's bookkeeping CLI: it writes units.tsv and ledger.tsv in the state
// folder and prints the merge-ready report from them and the live PRs.
//
// Exit codes: 0 clean, 1 a violation (not merge-ready, trees differ), 2 could not run or
// refused input.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  type LedgerColumn,
  RISK_LEDGER_COLUMNS,
  RISK_LEVELS,
  UNIT_COLUMNS,
  UNIT_STATES,
  type UnitColumn,
  type Verdict,
  isUnitColumn,
  ledgerColumnsOf,
  parseLedger,
  parseUnits,
} from "./state.ts";
import { Refusal, tsvLine } from "./tsv.ts";

const USAGE = `Usage: chunk.ts --state <dir> <command>

  ledger record <pr> <sha> <outcome> <evidence> [--risk <low|medium|high> --risk-reason <text>]
  ledger carry <pr> <new-sha> <from-sha> [-C <repo-dir>]
  unit add <id> <column>=<value>...
  unit set <id> <column>=<value>...
  report

The state folder comes from --state, else $IMPLEMENT_CHUNK_STATE.
Outcomes come from the Ledger outcomes table in implement-chunk/brief.md.
A state folder whose mode file reads sh4dow refuses a verdict without a risk call. A ledger
keeps the header it was created with: risk columns only if the mode file read sh4dow then.
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

type NewVerdict = Pick<Verdict, "sha" | "outcome" | "evidence" | "risk" | "riskReason"> & {
  readonly pr: string;
};

/** Which coordinator runs the chunk. */
type RunMode = "sh4dow" | "implement-chunk";

/**
 * The run mode the state folder's `mode` file names: absent for /implement-chunk, and `sh4dow`
 * for a sh4dow run, whose every verdict carries a risk call. Any other mode is refused.
 */
function runMode(state: string): RunMode {
  const file = join(state, "mode");
  const mode = readIfPresent(file)?.trim() ?? null;

  if (mode === null) return "implement-chunk";

  if (mode === "sh4dow") return mode;

  throw new Refusal(
    `${file}: unknown mode ${JSON.stringify(mode)}; a sh4dow run writes "sh4dow" there, ` +
      "and an implement-chunk run writes no mode file",
  );
}

/**
 * Creates the ledger with its header unless another writer got there first. The header lands
 * whole, by a hard link of a finished file, so a concurrent writer never reads it half written.
 */
function createLedger(path: string, columns: readonly LedgerColumn[]): void {
  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, `${tsvLine(columns)}\n`);

  try {
    linkSync(temporary, path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Appends one row, and never rewrites what the ledger holds, so concurrent writers and older
 * CLI versions can share it. The run mode fixes the header of a ledger created now.
 */
function appendVerdict(state: string, verdict: NewVerdict): Result {
  const path = join(state, "ledger.tsv");
  const modePath = join(state, "mode");
  const mode = runMode(state);
  const shown = [verdict.pr, verdict.sha, verdict.outcome, verdict.evidence].join("\t");

  if (mode === "sh4dow" && verdict.risk === null) {
    throw new Refusal(
      `${modePath} reads sh4dow, so each verdict needs a risk call: ` +
        `ledger record <pr> <sha> <outcome> <evidence> --risk <low|medium|high> --risk-reason <text>; ` +
        `refused this line:\n${shown}`,
    );
  }

  const cells: Record<LedgerColumn, string> = {
    pr: verdict.pr,
    head_sha: verdict.sha,
    outcome: verdict.outcome,
    evidence: verdict.evidence,
    risk: verdict.risk ?? "",
    risk_reason: verdict.riskReason,
    recorded_at: new Date().toISOString(),
  };

  const existing = readIfPresent(path);
  const wanted = mode === "sh4dow" ? RISK_LEDGER_COLUMNS : LEDGER_COLUMNS;
  const columns = existing === null ? wanted : ledgerColumnsOf(path, existing);

  if (verdict.risk !== null && !columns.includes("risk")) {
    throw new Refusal(
      `${path} has no risk columns, so it takes no risk call: chunk gives a ledger risk ` +
        `columns only when ${modePath} reads sh4dow as the ledger is created, and never ` +
        `rewrites a ledger's header. Record the verdict without --risk and put ` +
        `"risk: <level>: <reason>" in the evidence text; refused this line:\n${shown}`,
    );
  }

  // Built before the ledger is created, so a refused cell leaves a fresh state folder as it was.
  const row = `${tsvLine(columns.map((column) => cells[column]))}\n`;

  if (existing === null) {
    createLedger(path, columns);

    // ledgerColumnsOf returns one of the two column constants, so they compare by identity.
    if (ledgerColumnsOf(path, readFileSync(path, "utf8")) !== columns) {
      throw new Refusal(`${path}: another writer created it with other columns; rerun`);
    }
  }

  appendFileSync(path, row);

  const number = ledgerRows(path).length + 1;
  const risk = verdict.risk === null ? "" : ` ${verdict.risk}`;

  return {
    out: `${path}:${number}: ${verdict.pr} ${verdict.sha} ${verdict.outcome}${risk}`,
    exit: 0,
  };
}

interface RiskFlags {
  readonly risk: string | undefined;
  readonly reason: string | undefined;
}

function recordVerdict(state: string, args: readonly string[], flags: RiskFlags): Result {
  const [prText = "", shaText = "", outcome = "", evidence = "", ...extra] = args;

  if (extra.length > 0 || evidence === "") {
    throw new Refusal(
      "ledger record takes <pr> <sha> <outcome> <evidence> " +
        "[--risk <low|medium|high> --risk-reason <text>]",
    );
  }

  const level = RISK_LEVELS.find((name) => name === flags.risk) ?? null;
  const riskCallGiven = flags.risk !== undefined || flags.reason !== undefined;

  if (riskCallGiven && (level === null || (flags.reason ?? "").trim() === "")) {
    throw new Refusal(
      `a risk call is --risk <${RISK_LEVELS.join("|")}> with --risk-reason <text>, ` +
        `a one-line reason; got --risk ${JSON.stringify(flags.risk ?? null)} ` +
        `--risk-reason ${JSON.stringify(flags.reason ?? null)}`,
    );
  }

  const pr = formatPrRef(prArgument(prText));
  const sha = fullSha(shaText);
  const outcomes = readOutcomes();

  ledgerRows(join(state, "ledger.tsv"));

  if (!outcomes.has(outcome)) {
    throw new Refusal(
      `"${outcome}" is not a Ledger outcome in ${BRIEF}; refused this line:\n` +
        `${[pr, sha, outcome, evidence].join("\t")}\n` +
        `Ledger outcomes: ${[...outcomes.keys()].join(", ")}`,
    );
  }

  return appendVerdict(state, {
    pr,
    sha,
    outcome,
    evidence,
    risk: level,
    riskReason: level === null ? "" : (flags.reason ?? ""),
  });
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

function carryVerdict(state: string, args: readonly string[], repoDir: string): Result {
  const [prText = "", newText = "", fromText = "", ...extra] = args;

  if (extra.length > 0 || fromText === "") {
    throw new Refusal("ledger carry takes <pr> <new-sha> <from-sha>");
  }

  const pr = prArgument(prText);
  const newSha = fullSha(newText);
  const fromSha = fullSha(fromText);
  const path = join(state, "ledger.tsv");
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

  return appendVerdict(state, {
    pr: formatPrRef(pr),
    sha: newSha,
    outcome: from.outcome,
    evidence: `carried from ${fromSha}`,
    risk: from.risk,
    riskReason: from.riskReason,
  });
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

    const value = arg.slice(split + 1);

    if (column === "state" && !UNIT_STATES.some((state) => state === value)) {
      throw new Refusal(`not a unit state: ${value}\nstates: ${UNIT_STATES.join(", ")}`);
    }

    values.set(column, value);
  }

  return values;
}

/** What `unit add` writes in a column the command leaves out. */
const NEW_UNIT: Partial<Record<UnitColumn, string>> = {
  final_pr: "-",
  state: "planned",
};

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

  const cells =
    existing ?? UNIT_COLUMNS.map((column) => NEW_UNIT[column] ?? (column === "id" ? id : ""));

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
    decisions: { name: "decisions.md", text: readIfPresent(join(state, "decisions.md")) },
    attention: { name: "attention.md", text: readIfPresent(join(state, "attention.md")) },
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
      risk: { type: "string" },
      "risk-reason": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help === true) return { out: USAGE, exit: 0 };

  const state = values.state ?? process.env.IMPLEMENT_CHUNK_STATE;

  if (state === undefined || state === "") throw new Refusal("no state folder: pass --state <dir>");

  if (!existsSync(state)) throw new Refusal(`state folder missing: ${state}`);

  const [group = "", command = "", ...args] = positionals;

  const flags = { risk: values.risk, reason: values["risk-reason"] };

  if (group === "ledger" && command === "record") return recordVerdict(state, args, flags);

  if (flags.risk !== undefined || flags.reason !== undefined) {
    throw new Refusal("--risk and --risk-reason go only with ledger record");
  }

  if (group === "ledger" && command === "carry") {
    return carryVerdict(state, args, values["repo-dir"] ?? process.cwd());
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
