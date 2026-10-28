#!/usr/bin/env node
// Grades past implement-chunk runs from their session files and state folders: what each
// coordinator session and each subagent it launched ran with, read, launched, and edited, and
// where a chunk's verdicts, merges, and units went wrong. Usage:
//   node evals/coordinator-runs/grade.ts --sessions <dir> --state <chunk state folder>... --out <dir>

import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { Option, Schema } from "effect";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  argument,
  customEntries,
  firstUserText,
  parseSession,
  promptSections,
  sessionHead,
  skillLoads,
  type ToolOperation,
} from "../lib/session.ts";
import { runPool } from "../lib/pool.ts";
import {
  CannotRun,
  formatPr,
  ghPullRequest,
  insideStateFolder,
  looseRefs,
  namesSha,
  stateFolderSource,
  readTable,
  resolver,
  type PrRef,
  type PullRequest,
  type TableRow,
} from "./chunk-state.ts";
import { launchCalls } from "./launches.ts";
import type {
  Chunk,
  ChunkGrade,
  Finding,
  FindingClass,
  GradedSession,
  Mode,
  Position,
} from "./model.ts";
import { findingsTable, sessionsTable, summary } from "./report.ts";
import { shellStatements } from "./shell-writes.ts";
import {
  firstSha,
  rowLink,
  type StateRowLink,
  type VerdictRow,
  writesUnit,
  writesVerdict,
} from "./state-writes.ts";

export { FINDING_CLASSES, type Finding, type FindingClass } from "./model.ts";

/** The heading that opens the expanded `/implement-chunk` prompt, the first user message of its coordinator. */
export const COORDINATOR_MARKER = "# Implement a chunk";

/** The custom entry `/sh4dow` writes before a coordinator session's first user message. */
export const SH4DOW_MODE_ENTRY = "sh4dow-mode";

// ---------------------------------------------------------------------------------------------
// Session files

const SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Every session file under `dir`, by the session id its name ends in. Opens none of them. */
function sessionFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();

  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const id = SESSION_FILE.exec(entry.name)?.[1];

    if (entry.isFile() && id !== undefined) files.set(id, join(entry.parentPath, entry.name));
  }

  return files;
}

/** The mode a coordinator session ran in, judged from its head alone, or none for any other session. */
function coordinatorMode(head: string): Mode | undefined {
  if (customEntries(head).some((entry) => entry.customType === SH4DOW_MODE_ENTRY)) return "sh4dow";

  return firstUserText(head)?.trimStart().startsWith(COORDINATOR_MARKER) ? "general" : undefined;
}

// ---------------------------------------------------------------------------------------------
// Which chunk a coordinator session ran

function chunkAt(dir: string): Chunk {
  const absolute = resolve(dir);

  return { dir: absolute, name: basename(absolute), project: basename(dirname(dirname(absolute))) };
}

/** How often the text names the state folder `dir`. */
function mentions(text: string, dir: string): number {
  return text.match(new RegExp(`${stateFolderSource(dir)}(?![\\w.-])`, "g"))?.length ?? 0;
}

/**
 * The chunk a coordinator session ran: the state folder it names most often, among the graded
 * chunks and every sibling chunk folder beside them. A session that names an ungraded sibling
 * most, such as a run still going, belongs to no graded chunk.
 */
interface SessionChunk {
  readonly chunk: Chunk | undefined;
  /** The graded chunks the session names that it does not belong to. */
  readonly passedOver: readonly Chunk[];
}

function chunkOfSession(text: string, graded: readonly Chunk[]): SessionChunk {
  const siblings = [...new Set(graded.map((chunk) => dirname(chunk.dir)))].flatMap((parent) =>
    readdirSync(parent, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? [join(parent, entry.name)] : [],
    ),
  );

  const counted = [...new Set([...graded.map((chunk) => chunk.dir), ...siblings])]
    .flatMap((dir) => {
      const count = mentions(text, dir);

      return count > 0 ? [{ dir, count }] : [];
    })
    .toSorted((a, b) => b.count - a.count);

  const chunk = graded.find((candidate) => candidate.dir === counted[0]?.dir);

  const passedOver = graded.filter(
    (candidate) => candidate !== chunk && counted.some((entry) => entry.dir === candidate.dir),
  );

  return { chunk, passedOver };
}

const decodeSessionHeader = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("session"), cwd: Schema.String })),
);

/** The directory a session ran in, from the header on its first line. */
function sessionCwd(jsonl: string): string {
  const header = decodeSessionHeader(jsonl.split("\n", 1)[0]);

  return Option.isSome(header) ? header.value.cwd : "/";
}

// ---------------------------------------------------------------------------------------------
// The launch tree

function gradeSessionFile(input: {
  readonly id: string;
  readonly file: string;
  readonly chunk: Chunk;
  readonly mode: Mode;
  readonly role: string;
  readonly position: Position;
  readonly parent: string | undefined;
  readonly depth: number;
  readonly jsonl: string;
}): GradedSession {
  const session = parseSession(input.jsonl);
  const { launches, uncounted } = launchCalls(input.jsonl, session.operations);

  return {
    ...input,
    cwd: sessionCwd(input.jsonl),
    skillTable: promptSections(input.jsonl).skills ?? "",
    operations: session.operations,
    launches,
    uncountedLaunches: uncounted,
    finalText: session.finalText,
  };
}

/** The coordinator session and every session below it, depth first in launch order. */
function launchTree(
  coordinator: GradedSession,
  files: ReadonlyMap<string, string>,
  seen: Set<string>,
  warn: (line: string) => void,
): GradedSession[] {
  const visit = (session: GradedSession): GradedSession[] => [
    session,
    ...session.launches.flatMap((launch) => {
      if (launch.child === undefined || seen.has(launch.child)) return [];

      const file = files.get(launch.child);

      if (file === undefined) {
        warn(`${session.id} launched ${launch.child}, whose session file is not under --sessions`);

        return [];
      }

      seen.add(launch.child);

      return visit(
        gradeSessionFile({
          id: launch.child,
          file,
          chunk: session.chunk,
          mode: "subagent",
          role: launch.role,
          position: { at: "subagent", kind: launch.kind },
          parent: session.id,
          depth: session.depth + 1,
          jsonl: readFileSync(file, "utf8"),
        }),
      );
    }),
  ];

  return visit(coordinator);
}

// ---------------------------------------------------------------------------------------------
// Findings

const TERMINAL_UNIT_STATES = new Set(["merged", "done", "abandoned", "reconciled"]);

/**
 * A free-text unit state's first word: its first run of letters, which ends at a `-`, `(`,
 * space, or any other non-letter, so `abandoned-canceled(...)` and `done: 0 act-on` read as
 * `abandoned` and `done`.
 */
const firstWord = (state: string) => /[a-z]+/.exec(state.toLowerCase())?.[0] ?? "";

function sessionFindings(session: GradedSession): Finding[] {
  const findings: Finding[] = [];

  const add = (entry: string | undefined, findingClass: FindingClass, detail: string) =>
    findings.push({ session: session.id, entry: entry ?? "-", findingClass, detail });

  for (const load of skillLoads(session.operations)) {
    add(session.operations[load.step]?.entryId, "skill-read", load.skill);
  }

  for (const launch of session.launches) {
    const depth = session.depth + 1;
    const detail = `kind=${launch.kind} role=${launch.role} depth=${depth} child=${launch.child ?? "unknown"}`;

    add(launch.entry, "launch", detail);

    const launcher = session.position.at === "root" ? "root" : session.position.kind;

    if (launcher === "delegate") add(launch.entry, "wrong-spawn", `a delegate launched: ${detail}`);
    else if (launcher === "owner" && launch.kind === "owner") {
      add(launch.entry, "wrong-spawn", `an owner launched an owner: ${detail}`);
    } else if (depth > 2) add(launch.entry, "wrong-spawn", `depth over 2: ${detail}`);
  }

  if (session.position.at === "root") {
    for (const operation of session.operations) {
      for (const path of writtenPaths(operation, session.cwd)) {
        if (!insideStateFolder(path, session.chunk.dir)) add(operation.entryId, "root-edit", path);
      }
    }
  }

  return findings;
}

/** The absolute paths a successful call wrote: an `edit` or `write` path, or a bash command's shell writes. */
function writtenPaths(operation: ToolOperation, cwd: string): string[] {
  if (!operation.succeeded) return [];

  if (operation.tool === "edit" || operation.tool === "write") {
    const written = argument(operation, "path");

    return written === undefined ? [] : [resolve(cwd, written.replace(/^~(?=\/)/, homedir()))];
  }

  const command = operation.tool === "bash" ? argument(operation, "command") : undefined;

  return command === undefined
    ? []
    : shellStatements(command, cwd).flatMap((statement) => statement.writes);
}

async function chunkFindings(
  chunk: Chunk,
  sessions: readonly GradedSession[],
  lookup: (ref: PrRef) => Promise<PullRequest | undefined>,
  warn: (line: string) => void,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const coordinators = sessions.filter((session) => session.position.at === "root");
  const unitsFile = join(chunk.dir, "units.tsv");
  const units = readTable(unitsFile);
  const ledgerFile = join(chunk.dir, "ledger.tsv");
  const ledger = readTable(ledgerFile);

  const resolveRef = resolver([
    ...units.flatMap((unit) => [unit.cell("final_pr"), unit.cell("intermediate_pr")]),
    ...ledger.map((row) => row.cell("pr")),
  ]);

  /** The identity of `pr`'s ledger row `row`: the pull request and the row's head SHA. */
  const verdictOf = (pr: string, row: TableRow): VerdictRow => ({
    sha: firstSha(row),
    namesPr: (word) =>
      looseRefs(word).some((loose) => {
        const ref = resolveRef(loose);

        return ref !== undefined && formatPr(ref) === pr;
      }),
  });

  // Pull requests the state files name, each looked up once.
  const refs = new Map<string, PrRef>();

  for (const cell of [
    ...units.flatMap((unit) => [unit.cell("final_pr"), unit.cell("intermediate_pr")]),
    ...ledger.map((row) => row.cell("pr").split(/\s+/)[0] ?? ""),
  ]) {
    for (const loose of looseRefs(cell)) {
      const ref = resolveRef(loose);

      if (ref) refs.set(formatPr(ref), ref);
    }
  }

  const pulls = new Map<string, PullRequest>();

  await runPool([...refs.values()], 6, async (ref) => {
    const pull = await lookup(ref);

    if (pull) pulls.set(formatPr(ref), pull);
    else warn(`${chunk.name}: gh found no pull request ${formatPr(ref)}`);
  });

  // Stale verdicts: a merged pull request whose ledger rows name no head it merged at.
  const rowsByPr = new Map<string, TableRow[]>();

  for (const row of ledger) {
    const loose = looseRefs(row.cell("pr").split(/\s+/)[0] ?? "")[0];
    const ref = loose && resolveRef(loose);

    if (!ref) {
      warn(`${chunk.name}: ${ledgerFile}:${row.line}: no pull request in "${row.cell("pr")}"`);
      continue;
    }

    rowsByPr.set(formatPr(ref), [...(rowsByPr.get(formatPr(ref)) ?? []), row]);
  }

  for (const [pr, rows] of rowsByPr) {
    const pull = pulls.get(pr);

    if (pull?.state !== "MERGED") continue;

    if (rows.some((row) => namesSha(row.cell("head_sha"), pull.headRefOid))) continue;

    const last = rows[rows.length - 1];
    const link = rowLink(coordinators, ledgerFile, last, writesVerdict(chunk, verdictOf(pr, last)));

    findings.push({
      session: link.session,
      entry: link.entry,
      findingClass: "stale-verdict",
      detail: `${pr} ${link.at}`,
    });
  }

  // Report-only merges: a merged final PR whose merged head no verifier session's verdict names.
  const verdicts = sessions.flatMap((session) =>
    session.role === "verifier" ? [session.finalText] : [],
  );

  for (const [pr, pull] of pulls) {
    if (pull.state !== "MERGED" || !pull.headRefName.startsWith("chunk/")) continue;

    if (verdicts.some((verdict) => namesSha(verdict, pull.headRefOid))) continue;

    // The row the merge comes from: the verdict at the merged head, else the unit that owns the
    // PR, else the PR's last verdict.
    const prRows = rowsByPr.get(pr) ?? [];
    const verdictRow = prRows.findLast((row) => namesSha(row.cell("head_sha"), pull.headRefOid));

    const unitRow = units.findLast((unit) =>
      [unit.cell("final_pr"), unit.cell("intermediate_pr")].flatMap(looseRefs).some((loose) => {
        const ref = resolveRef(loose);

        return ref !== undefined && formatPr(ref) === pr;
      }),
    );

    const ledgerRow = verdictRow ?? (unitRow === undefined ? prRows.at(-1) : undefined);

    let link: StateRowLink | undefined;

    if (ledgerRow !== undefined) {
      link = rowLink(
        coordinators,
        ledgerFile,
        ledgerRow,
        writesVerdict(chunk, verdictOf(pr, ledgerRow)),
      );
    } else if (unitRow !== undefined) {
      link = rowLink(coordinators, unitsFile, unitRow, writesUnit(chunk, unitRow.cell("id")));
    }

    findings.push({
      session: link?.session ?? coordinators[0]?.id ?? "-",
      entry: link?.entry ?? "-",
      findingClass: "report-only-merge",
      detail: `${pr} ${pull.headRefOid}${link === undefined ? "" : ` ${link.at}`}`,
    });
  }

  // Unterminated subagents: a unit whose state is not terminal, unless it was planned and never launched.
  const launches = sessions.flatMap((session) =>
    session.launches.map((launch) => ({ session: session.id, launch })),
  );

  for (const unit of units) {
    const state = unit.cell("state");
    const first = firstWord(state);

    if (TERMINAL_UNIT_STATES.has(first)) continue;

    const brief = unit.cell("brief");

    const launched =
      brief === "" || brief === "-"
        ? undefined
        : launches.findLast(({ launch }) => launch.command.includes(`/${brief}`));

    if (first === "planned" && launched === undefined) continue;

    const link = rowLink(coordinators, unitsFile, unit, writesUnit(chunk, unit.cell("id")));

    findings.push({
      session: link.session,
      entry: link.entry,
      findingClass: "unterminated-subagent",
      detail: `${unit.cell("id")} ${state} ${link.at}`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------------------------
// Grading a set of chunks

export async function gradeChunks(input: {
  readonly sessionsDir: string;
  readonly stateDirs: readonly string[];
  readonly lookup: (ref: PrRef) => Promise<PullRequest | undefined>;
  readonly warn: (line: string) => void;
}): Promise<ChunkGrade[]> {
  const chunks = input.stateDirs.map(chunkAt);
  const files = sessionFiles(input.sessionsDir);
  const byChunk = new Map<string, GradedSession[]>(chunks.map((chunk) => [chunk.dir, []]));
  const passedOverBy = new Map<string, number>();
  const seen = new Set<string>();

  const coordinators = [...files]
    .toSorted(([, a], [, b]) => basename(a).localeCompare(basename(b)))
    .flatMap(([id, file]) => {
      const mode = coordinatorMode(sessionHead(file));

      return mode === undefined ? [] : [{ id, file, mode }];
    });

  for (const { id, file, mode } of coordinators) {
    const jsonl = readFileSync(file, "utf8");
    const { chunk, passedOver } = chunkOfSession(jsonl, chunks);

    for (const other of passedOver) {
      passedOverBy.set(other.dir, (passedOverBy.get(other.dir) ?? 0) + 1);
    }

    if (chunk === undefined) continue;

    seen.add(id);

    const coordinator = gradeSessionFile({
      id,
      file,
      chunk,
      mode,
      role: "coordinator",
      position: { at: "root" },
      parent: undefined,
      depth: 0,
      jsonl,
    });

    byChunk.get(chunk.dir)?.push(...launchTree(coordinator, files, seen, input.warn));
  }

  return Promise.all(
    chunks.map(async (chunk): Promise<ChunkGrade> => {
      const sessions = byChunk.get(chunk.dir) ?? [];

      const passedOver = passedOverBy.get(chunk.dir) ?? 0;

      if (sessions.length === 0 && passedOver === 0) {
        input.warn(`${chunk.name}: no coordinator session names ${chunk.dir}`);
      } else if (sessions.length === 0) {
        input.warn(
          `${chunk.name}: ${passedOver === 1 ? "1 coordinator session names" : `${passedOver} coordinator sessions name`} ${chunk.dir}, but ${passedOver === 1 ? "names" : "each names"} another chunk folder more often, so none is graded here`,
        );
      }

      // The warning leaves out the recorded command, which can hold a credential or a private
      // prompt; the session file and entry id find it.
      for (const session of sessions) {
        for (const call of session.uncountedLaunches) {
          input.warn(
            `${session.file}: entry ${call.entry}: not counted as a launch: codemode cut its recorded command short and it started no child session`,
          );
        }
      }

      return {
        chunk,
        sessions,
        findings: [
          ...sessions.flatMap(sessionFindings),
          ...(await chunkFindings(chunk, sessions, input.lookup, input.warn)),
        ],
        unlinkedLaunches: sessions
          .flatMap((session) => session.launches)
          .filter((launch) => launch.child === undefined).length,
      };
    }),
  );
}

const USAGE = "usage: grade.ts --sessions <dir> --state <chunk state folder>... --out <dir>";

function parseArgs(args: readonly string[]) {
  const values = new Map<string, string[]>();
  let current: string | undefined;

  for (const arg of args) {
    const flag = /^--(sessions|state|out)$/.exec(arg)?.[1];

    if (flag !== undefined) {
      current = flag;
      values.set(flag, values.get(flag) ?? []);
    } else if (current === undefined) {
      throw new CannotRun(`unexpected argument ${arg}\n${USAGE}`);
    } else values.get(current)?.push(arg);
  }

  const sessions = values.get("sessions") ?? [];
  const out = values.get("out") ?? [];
  const state = values.get("state") ?? [];

  if (sessions.length !== 1 || out.length !== 1 || state.length === 0) throw new CannotRun(USAGE);

  for (const dir of [sessions[0], ...state]) {
    if (!existsSync(dir)) throw new CannotRun(`${dir}: no such directory`);
  }

  return { sessionsDir: sessions[0], stateDirs: state, out: out[0] };
}

const shellQuote = (arg: string) =>
  /^[\w@%+=:,./~-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;

const warn = (line: string) => process.stderr.write(`${line}\n`);

async function main(args: readonly string[]) {
  const { sessionsDir, stateDirs, out } = parseArgs(args);
  const grades = await gradeChunks({ sessionsDir, stateDirs, lookup: ghPullRequest, warn });

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "sessions.tsv"), sessionsTable(grades));
  writeFileSync(join(out, "findings.tsv"), findingsTable(grades));
  writeFileSync(
    join(out, "command.txt"),
    `${["node", "evals/coordinator-runs/grade.ts", ...args].map(shellQuote).join(" ")}\n`,
  );

  const written = isAbsolute(out) ? out : resolve(out);

  process.stdout.write(
    `${summary(grades)}\n\nWrote ${join(written, "sessions.tsv")}, findings.tsv, command.txt\n`,
  );
}

// Exit 2: the grader could not run, such as on bad arguments or with no gh to read merged heads.
if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
