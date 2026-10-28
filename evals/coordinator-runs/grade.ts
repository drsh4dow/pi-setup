#!/usr/bin/env node
// Grades past implement-chunk runs from their session files and state folders: what each
// coordinator session and each subagent it launched ran with, read, launched, and edited, and
// where a chunk's verdicts, merges, and units went wrong. Usage:
//   node evals/coordinator-runs/grade.ts --sessions <dir> --state <chunk state folder>... --out <dir>

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  argument,
  customEntries,
  firstUserText,
  promptSections,
  sessionHead,
  skillLoads,
  type ToolOperation,
} from "../lib/session.ts";
import {
  CannotRun,
  ghPullRequest,
  gitOrigin,
  insideStateFolder,
  stateFolderSource,
} from "./chunk-state.ts";
import { chunkFindings, type PullRequestSources } from "./chunk-findings.ts";
import { type Launch, launchCalls } from "./launches.ts";
import { namedChildJoiner } from "./named-children.ts";
import {
  type HeadFacts,
  headFacts,
  readSessionFile,
  sessionCwd,
  sessionFiles,
} from "./session-files.ts";
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

export { FINDING_CLASSES, type Finding, type FindingClass } from "./model.ts";

/** The heading that opens the expanded `/implement-chunk` prompt, the first user message of its coordinator. */
export const COORDINATOR_MARKER = "# Implement a chunk";

/** The custom entry `/sh4dow` writes before a coordinator session's first user message. */
export const SH4DOW_MODE_ENTRY = "sh4dow-mode";

// ---------------------------------------------------------------------------------------------
// Session files

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

// ---------------------------------------------------------------------------------------------
// The launch tree

/** Joins one session's launches, in call order, to the child sessions no record names. */
type ChildJoin = (launches: readonly Launch[]) => Launch[];

/** The graded session, or none when a line of its file is no session entry. */
function gradeSessionFile({
  warn,
  joinChildren,
  ...input
}: {
  readonly id: string;
  readonly file: string;
  readonly chunk: Chunk;
  readonly mode: Mode;
  readonly role: string;
  readonly position: Position;
  readonly parent: string | undefined;
  readonly depth: number;
  readonly jsonl: string;
  readonly joinChildren: ChildJoin;
  readonly warn: (line: string) => void;
}): GradedSession | undefined {
  const session = readSessionFile(input.file, input.jsonl, warn);

  if (session === undefined) return undefined;

  const calls = launchCalls(input.jsonl, session.operations);
  const launches = joinChildren(calls.launches);
  const uncounted = calls.uncounted;

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
  joinChildren: ChildJoin,
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

      const child = gradeSessionFile({
        id: launch.child,
        file,
        chunk: session.chunk,
        mode: "subagent",
        role: launch.role,
        position: { at: "subagent", kind: launch.kind },
        parent: session.id,
        depth: session.depth + 1,
        jsonl: readFileSync(file, "utf8"),
        joinChildren,
        warn,
      });

      return child === undefined ? [] : visit(child);
    }),
  ];

  return visit(coordinator);
}

// ---------------------------------------------------------------------------------------------
// Findings

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
        if (insideStateFolder(path, session.chunk.dir) || insideTempDir(path)) continue;

        add(operation.entryId, "root-edit", path);
      }
    }
  }

  return findings;
}

/** The directory `dir` resolves to, or `dir` itself when it does not resolve. */
function landing(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * The temp directories the delegate guard lets a coordinator write scratch files in: `/tmp` and
 * the system temp directory, as written and as each resolves. The grader takes its own system temp
 * directory for the coordinator's, as both run as one user.
 */
const TEMP_DIRS = [...new Set(["/tmp", tmpdir()].flatMap((dir) => [dir, landing(dir)]))];

const insideTempDir = (path: string) =>
  TEMP_DIRS.some((dir) => path === dir || path.startsWith(`${dir.replace(/\/$/, "")}/`));

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

// ---------------------------------------------------------------------------------------------
// Grading a set of chunks

/** A session file and what its head says. */
interface SessionHeadOf extends HeadFacts {
  readonly id: string;
  readonly file: string;
  /** The mode it ran in when it is a coordinator session, judged from its head alone. */
  readonly mode: Mode | undefined;
}

export async function gradeChunks(input: {
  readonly sessionsDir: string;
  readonly stateDirs: readonly string[];
  readonly lookup: PullRequestSources["lookup"];
  readonly origin: PullRequestSources["origin"];
  readonly warn: (line: string) => void;
}): Promise<ChunkGrade[]> {
  const chunks = input.stateDirs.map(chunkAt);
  const files = sessionFiles(input.sessionsDir);
  const byChunk = new Map<string, GradedSession[]>(chunks.map((chunk) => [chunk.dir, []]));
  const passedOverBy = new Map<string, number>();
  const seen = new Set<string>();

  // Each session's head is read once, and no session is read past it unless it is graded.
  const heads: SessionHeadOf[] = [...files]
    .toSorted(([, a], [, b]) => basename(a).localeCompare(basename(b)))
    .map(([id, file]) => {
      const head = sessionHead(file);
      const { startedAt, continues, name } = headFacts(head);

      return { id, file, mode: coordinatorMode(head), startedAt, continues, name };
    });

  const joiner = namedChildJoiner(
    heads.flatMap(({ id, mode, continues, name, startedAt }) =>
      mode === undefined && continues === undefined && name !== undefined
        ? [{ id, name, startedAt }]
        : [],
    ),
  );

  const joinChildren: ChildJoin = (launches) => joiner(launches, seen);

  const coordinators = heads.flatMap(({ id, file, mode }) =>
    mode === undefined ? [] : [{ id, file, mode }],
  );

  /**
   * The sessions that continue `continued` through Pi's handoff, each graded as a coordinator of
   * its chunk and in its mode, then the trees they launched and the handoffs that continue them.
   */
  const handoffTrees = (continued: GradedSession): GradedSession[] => {
    const trees: GradedSession[] = [];

    for (const head of heads) {
      if (head.mode !== undefined || head.continues !== continued.id || seen.has(head.id)) {
        continue;
      }

      seen.add(head.id);

      const handoff = gradeSessionFile({
        id: head.id,
        file: head.file,
        chunk: continued.chunk,
        mode: continued.mode,
        role: "coordinator",
        position: { at: "root" },
        parent: continued.id,
        depth: 0,
        jsonl: readFileSync(head.file, "utf8"),
        joinChildren,
        warn: input.warn,
      });

      if (handoff === undefined) continue;

      trees.push(
        ...launchTree(handoff, files, seen, joinChildren, input.warn),
        ...handoffTrees(handoff),
      );
    }

    return trees;
  };

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
      joinChildren,
      warn: input.warn,
    });

    if (coordinator === undefined) continue;

    byChunk
      .get(chunk.dir)
      ?.push(
        ...launchTree(coordinator, files, seen, joinChildren, input.warn),
        ...handoffTrees(coordinator),
      );
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
          ...(await chunkFindings(chunk, sessions, input, input.warn)),
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

  const grades = await gradeChunks({
    sessionsDir,
    stateDirs,
    lookup: ghPullRequest,
    origin: gitOrigin,
    warn,
  });

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
