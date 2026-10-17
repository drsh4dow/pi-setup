import type { Args } from "@earendil-works/pi-coding-agent";
import { Effect, Option, Schema } from "effect";

export const PaneId = Schema.NonEmptyString.pipe(Schema.brand("PaneId"));

export type PaneId = typeof PaneId.Type;

export const TabId = Schema.NonEmptyString.pipe(Schema.brand("TabId"));

export type TabId = typeof TabId.Type;

export const WorkspaceId = Schema.NonEmptyString.pipe(Schema.brand("WorkspaceId"));

export type WorkspaceId = typeof WorkspaceId.Type;

export const HerdrPane = Schema.Struct({
  pane_id: PaneId,
  workspace_id: WorkspaceId,
});

export const PaneListResponse = Schema.Struct({
  result: Schema.Struct({
    panes: Schema.Array(Schema.Struct({ pane_id: PaneId, cwd: Schema.String })),
  }),
});

export interface Lineage {
  readonly parentPane: PaneId;
  readonly workspace: WorkspaceId;
  readonly depth: number;
}

/**
 * Herdr lists agents in tab order, then pane order within a tab. A depth-1 child gets its own
 * tab; a deeper child splits its owner's pane so its sidebar row lands directly under the owner.
 */
export type Placement =
  | { readonly kind: "tab"; readonly workspace: WorkspaceId }
  | { readonly kind: "split"; readonly target: PaneId };

export function placementFor(lineage: Lineage): Placement {
  if (lineage.depth === 1) return { kind: "tab", workspace: lineage.workspace };

  return { kind: "split", target: lineage.parentPane };
}

export type Environment = Readonly<Partial<Record<string, string>>>;

export type Mode =
  | { readonly kind: "print" }
  | { readonly kind: "herdr"; readonly pane: PaneId; readonly depth: number };

const HerdrCaller = Schema.Struct({
  HERDR_ENV: Schema.Literal("1"),
  HERDR_SOCKET_PATH: Schema.NonEmptyString,
  HERDR_PANE_ID: PaneId,
});

export const herdrCaller = Schema.decodeUnknownOption(HerdrCaller);

const ParentDepth = Schema.Struct({
  PI_SUBAGENT_DEPTH: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});

export const modeFrom = Effect.fnUntraced(function* (env: Environment) {
  const caller = herdrCaller(env);

  if (Option.isNone(caller)) return { kind: "print" } satisfies Mode;

  const { PI_SUBAGENT_DEPTH: parentDepth = 0 } = yield* Schema.decodeEffect(ParentDepth)(env);

  return { kind: "herdr", pane: caller.value.HERDR_PANE_ID, depth: parentDepth + 1 } satisfies Mode;
});

/** Herdr strips leading spaces and NBSP from a display label, so every prefix starts visibly. */
export function treeLabel(depth: number, name: string): string {
  return `${"│  ".repeat(Math.max(0, depth - 1))}└─ ${name}`;
}

const SESSION_NAME_PREFIX = "subagent:";

export function subagentName(sessionName: string | undefined): string {
  if (sessionName === undefined) return "subagent";

  const short = sessionName.startsWith(SESSION_NAME_PREFIX)
    ? sessionName.slice(SESSION_NAME_PREFIX.length).trim()
    : sessionName.trim();

  return short === "" ? "subagent" : short;
}

export function printOnlyReason(args: Args): string | undefined {
  if (args.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
    return "pi rejects these arguments";
  }

  if (args.messages.length > 0) return "the arguments hold messages";

  if (args.fileArgs.length > 0) return "the arguments attach @file inputs";

  if (args.mode !== undefined) return `--mode ${args.mode} replaces the chat`;

  if (args.resume) return "--resume opens a session picker";

  if (args.noExtensions) return "--no-extensions disables the child's extension";

  if (args.help || args.version || args.listModels !== undefined || args.export !== undefined) {
    return "the arguments ask for output instead of a run";
  }

  return undefined;
}

export const RunOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("completed"), report: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("truncated"), report: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("aborted"), report: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String }),
]);

export type RunOutcome = typeof RunOutcome.Type;

export const ChildResult = Schema.Union([
  RunOutcome,
  Schema.Struct({ kind: Schema.Literal("printInstead"), reason: Schema.String }),
]);

export type ChildResult = typeof ChildResult.Type;

const EXIT_CODES = { completed: 0, truncated: 1, failed: 1, aborted: 2 } as const satisfies Record<
  RunOutcome["kind"],
  number
>;

/** `pi --print` exits with Pi's own code when Pi fails after printing, so a non-zero exit wins. */
export function exitCodeFor(outcome: RunOutcome, piExitCode: number): number {
  return piExitCode === 0 ? EXIT_CODES[outcome.kind] : piExitCode;
}

export function runtimeRoot(env: Environment, temporaryDirectory: string): string {
  const configured = env.XDG_RUNTIME_DIR;

  if (configured === undefined || configured === "") return temporaryDirectory;

  return configured;
}

export const RUN_DIRECTORY_PREFIX = "pi-subagent-";

// Herdr reads a live pane's cwd from /proc/<pid>/cwd, where Linux marks a removed directory.
const RUN_DIRECTORY_NAME = /\/pi-subagent-[A-Za-z0-9]{6}( \(deleted\))?$/;

export function isRunDirectory(path: string): boolean {
  return RUN_DIRECTORY_NAME.test(path);
}

function utf8SequenceLength(leadByte: number): number {
  if (leadByte >= 0xf0) return 4;

  if (leadByte >= 0xe0) return 3;

  if (leadByte >= 0xc0) return 2;

  return 1;
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function completeCharactersEnd(bytes: Uint8Array): number {
  let lead = bytes.length - 1;

  while (lead > bytes.length - 4 && lead > 0 && isContinuationByte(bytes[lead])) lead -= 1;

  const leadByte = bytes[lead];

  if (leadByte === undefined || isContinuationByte(leadByte)) return bytes.length;

  return lead + utf8SequenceLength(leadByte) > bytes.length ? lead : bytes.length;
}

function utf8Prefix(bytes: Uint8Array, budget: number): Uint8Array {
  if (bytes.length <= budget) return bytes;

  let end = budget;

  while (end > 0 && isContinuationByte(bytes[end])) end -= 1;

  return bytes.subarray(0, end);
}

/**
 * Returns, for each chunk of a byte stream, the bytes to record so the record holds the first
 * `limit` bytes without a split UTF-8 character, then one line saying the rest was dropped. Bytes
 * of a character that a chunk boundary split wait for the next chunk.
 */
export function stderrRecorder(limit: number) {
  const encoder = new TextEncoder();
  const notice = `pi-subagent: pi wrote more than ${limit / 1024} KiB to stderr; the rest is not forwarded.\n`;
  let recorded = 0;
  let pending = new Uint8Array(0);
  let endsWithNewline = true;
  let full = false;

  return (chunk: Uint8Array): Uint8Array => {
    if (full) return new Uint8Array(0);

    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);

    const end = completeCharactersEnd(joined);
    pending = joined.slice(end);

    const complete = joined.subarray(0, end);
    const kept = utf8Prefix(complete, limit - recorded);
    recorded += kept.length;

    const last = kept.at(-1);

    if (last !== undefined) endsWithNewline = last === 0x0a;

    if (kept.length === complete.length) return kept;

    full = true;

    const truncation = encoder.encode(endsWithNewline ? notice : `\n${notice}`);
    const record = new Uint8Array(kept.length + truncation.length);
    record.set(kept);
    record.set(truncation, kept.length);

    return record;
  };
}

export const ChildLaunch = Schema.Struct({
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String)),
});

export type ChildLaunch = typeof ChildLaunch.Type;

export function runFiles(runDirectory: string) {
  return {
    launch: `${runDirectory}/launch.json`,
    task: `${runDirectory}/task.md`,
    started: `${runDirectory}/started`,
    claim: `${runDirectory}/claim`,
    stderr: `${runDirectory}/stderr`,
    outcome: `${runDirectory}/outcome.json`,
    exit: `${runDirectory}/exit`,
  };
}

const LAUNCHER_FILE_DESCRIPTOR_VARIABLES = new Set(["PI_BACKGROUND_TERMINAL_NOTIFY_FD"]);

function paneOwned(name: string): boolean {
  return (
    name.startsWith("HERDR_") ||
    name.startsWith("TERM") ||
    name.startsWith("TMUX") ||
    name === "COLORTERM"
  );
}

/**
 * A herdr pane inherits the herdr server's environment, not the launcher's. The child gets the
 * launcher's environment, as `pi --print` would, with the pane's own terminal and herdr identity.
 */
export function childEnv(launcher: Environment, pane: Environment): Environment {
  const inherited = Object.entries(launcher).filter(
    ([name]) => !paneOwned(name) && !LAUNCHER_FILE_DESCRIPTOR_VARIABLES.has(name),
  );

  const fromPane = Object.entries(pane).filter(([name]) => paneOwned(name));

  return Object.fromEntries([...inherited, ...fromPane]);
}
