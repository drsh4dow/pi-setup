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

const ParentDepth = Schema.Struct({
  PI_SUBAGENT_DEPTH: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});

export const modeFrom = Effect.fnUntraced(function* (env: Environment) {
  const caller = Schema.decodeUnknownOption(HerdrCaller)(env);

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

const EXIT_CODES = { completed: 0, truncated: 1, failed: 1, aborted: 2 } as const satisfies Record<
  RunOutcome["kind"],
  number
>;

export function exitCodeFor(outcome: RunOutcome): 0 | 1 | 2 {
  return EXIT_CODES[outcome.kind];
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
