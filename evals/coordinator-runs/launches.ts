// Finds the subagent launches a session made and the child session each one started, from its
// tool calls and from the background terminal reports the launcher printed into.

import { Option, Schema } from "effect";
import { argument, customMessages, type ToolOperation } from "../lib/session.ts";
import {
  commandIndices,
  commandName,
  CUT,
  flagValue,
  simpleCommands,
  withoutHeredocBodies,
} from "./shell.ts";

export type Kind = "delegate" | "owner" | "unknown";

export interface Launch {
  /** The id of the entry whose tool call made the launch. */
  readonly entry: string;
  readonly kind: Kind;
  readonly role: string;
  readonly command: string;
  /** The child session id, absent when no record names it. */
  readonly child: string | undefined;
  /** The name the launcher gives the child's session, absent when the command does not say. */
  readonly childName: string | undefined;
  /** When the model issued the call, absent in sessions that record no timestamps. */
  readonly calledAt: string | undefined;
}

/**
 * A call that may have launched, whose recorded command codemode cut short and which started no
 * child session. The session does not hold the rest of the command, so whether it was a dry run
 * cannot be told, and it is not counted as a launch.
 */
export interface UncountedLaunch {
  readonly entry: string;
}

// The subagents skill's launch.ts, raw pi-subagent, or the spawn.sh wrapper past chunks kept in
// their state folder.
const LAUNCHERS = new Set(["launch.ts", "pi-subagent", "spawn.sh"]);

const CHILD_SESSION = /launch: session ([0-9a-f]{8}-[0-9a-f-]{27})/g;

interface LaunchCommand {
  readonly kind: Kind;
  readonly role: string;
  readonly text: string;
  /** The session a `--session <id>` argument resumes. */
  readonly resumed: string | undefined;
  readonly childName: string | undefined;
}

/**
 * The name the launcher gives the child's session from its `--name`: launch.ts opens it with
 * `subagent: ` when the name does not, and pi-subagent passes it to Pi as it is.
 */
function childNameIn(launcher: string, args: readonly string[]): string | undefined {
  const name = flagValue(args, "--name");

  if (name === undefined || launcher !== "launch.ts" || name.startsWith("subagent: ")) return name;

  return `subagent: ${name}`;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;

function kindIn(args: readonly string[]): Kind {
  const flag = flagValue(args, "--kind");

  const prompt = args
    .map((arg) => /(?:subagents\/|system\/generated\/)(delegate|owner)(?:\.md|\/)/.exec(arg)?.[1])
    .find((found) => found !== undefined);

  const found = flag === "delegate" || flag === "owner" ? flag : prompt;

  return found === "delegate" || found === "owner" ? found : "unknown";
}

const hasFlag = (args: readonly string[], flag: RegExp) => args.some((arg) => flag.test(arg));

/**
 * The launches a command makes, one per launcher it runs, leaving out dry runs and help. A
 * launcher's arguments run to the end of its simple command, so a flag in a later statement or
 * inside a quoted argument is not one of them.
 */
function launchCommands(command: string): LaunchCommand[] {
  const shell = withoutHeredocBodies(command);

  return simpleCommands(shell).flatMap((words) => {
    const plain = words.filter((word) => word.redirect === undefined);

    const starts = commandIndices(plain).filter((index) =>
      LAUNCHERS.has(commandName(plain[index])),
    );

    return starts.flatMap((start, index): LaunchCommand[] => {
      const argWords = plain.slice(start + 1, starts[index + 1] ?? plain.length);
      const args = argWords.map((word) => word.text);
      const launcher = commandName(plain[start]);
      const text = shell.slice(plain[start].start, (argWords.at(-1) ?? plain[start]).end);
      const session = flagValue(args, "--session");
      const resumed = session !== undefined && SESSION_ID.test(session) ? session : undefined;

      if (hasFlag(args, /^--(?:dry-run|help|version)(?:=|$)/)) return [];

      if (launcher === "launch.ts" && !hasFlag(args, /^--(?:kind|brief)(?:=|$)/)) return [];

      if (
        launcher === "pi-subagent" &&
        !hasFlag(args, /^--(?:(?:append-)?system-prompt|session-id|name)(?:=|$)/)
      ) {
        return [];
      }

      if (launcher === "spawn.sh") {
        // spawn.sh <brief> <model> <thinking> <name> [owner]
        // The name the wrapper gives the session is the wrapper's own, so it is left unknown.
        const kind = args.at(-1) === "owner" ? "owner" : "delegate";

        return [{ kind, role: "unknown", text, resumed, childName: undefined }];
      }

      const role = /^[a-z-]+/.exec(flagValue(args, "--role") ?? "")?.[0] ?? "unknown";

      return [{ kind: kindIn(args), role, text, resumed, childName: childNameIn(launcher, args) }];
    });
  });
}

/**
 * One run of a background terminal. A resumed session's new Pi process numbers its terminals
 * from `bt-1` again, so an id names a run only between one start and the next.
 */
interface TerminalRun {
  readonly id: string;
  /** The 0-based index of the session file line the run starts at. */
  readonly at: number;
  /** The top-level `bg_start` that reported starting it, absent for a run only reports show. */
  readonly startedBy: ToolOperation | undefined;
  command: string | undefined;
  child: string | undefined;
}

/** What one terminal report, at one line of the session file, says about one terminal. */
interface TerminalReport {
  readonly id: string;
  readonly at: number;
  readonly command: string | undefined;
  readonly child: string | undefined;
}

const TerminalDetails = Schema.Struct({
  terminals: Schema.Array(Schema.Struct({ id: Schema.String, command: Schema.String })),
});

const decodeTerminalDetails = Schema.decodeUnknownOption(TerminalDetails);

const decodeEntryId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
);

/** The line each entry id sits on in the session file. */
function entryLines(jsonl: string): Map<string, number> {
  const lines = new Map<string, number>();

  jsonl.split("\n").forEach((line, index) => {
    const entry = decodeEntryId(line);

    if (Option.isSome(entry)) lines.set(entry.value.id, index);
  });

  return lines;
}

function reportsIn(text: string, at: number, commands: ReadonlyMap<string, string>) {
  const reports: TerminalReport[] = [];

  for (const block of text.split(/^(?=bt-\d+ \[)/m)) {
    const id = /^(bt-\d+) \[/.exec(block)?.[1];

    if (id === undefined) continue;

    reports.push({
      id,
      at,
      command: commands.get(id) ?? /^command: (.*)$/m.exec(block)?.[1],
      child: [...block.matchAll(CHILD_SESSION)][0]?.[1],
    });
  }

  return reports;
}

/** Every terminal run the session shows, from its starts and from the reports that follow them. */
function terminalRuns(
  jsonl: string,
  operations: readonly ToolOperation[],
  lineOf: ReadonlyMap<string, number>,
): TerminalRun[] {
  const at = (id: string | undefined) => (id === undefined ? -1 : (lineOf.get(id) ?? -1));
  const runs: TerminalRun[] = [];
  const reports: TerminalReport[] = [];

  for (const operation of operations) {
    const started = /Started (bt-\d+)/.exec(operation.output)?.[1];
    const command = argument(operation, "command");

    if (operation.tool === "bg_start" && started !== undefined && command !== undefined) {
      runs.push({
        id: started,
        at: at(operation.entryId),
        startedBy: operation,
        command,
        child: undefined,
      });
    }

    if (operation.tool === "bg_status" || operation.tool === "bg_list") {
      reports.push(...reportsIn(operation.output, at(operation.entryId), new Map()));
    }
  }

  for (const message of customMessages(jsonl)) {
    if (message.customType !== "background-terminal-results") continue;

    const details = decodeTerminalDetails(message.details);

    const commands = new Map(
      Option.isSome(details)
        ? details.value.terminals.map((terminal) => [terminal.id, terminal.command])
        : [],
    );

    reports.push(...reportsIn(message.text, at(message.id), commands));
  }

  // Each report belongs to the latest run of its id; one whose command differs belongs to a run
  // no recorded start opened, such as one a codemode script started.
  const latest = new Map<string, TerminalRun>();

  const events = [
    ...runs.map((run) => ({ at: run.at, run, report: undefined })),
    ...reports.map((report) => ({ at: report.at, run: undefined, report })),
  ].toSorted((a, b) => a.at - b.at || (a.run ? -1 : 0) - (b.run ? -1 : 0));

  for (const event of events) {
    if (event.run) {
      latest.set(event.run.id, event.run);
      continue;
    }

    const { report } = event;
    let run = latest.get(report.id);

    if (
      run === undefined ||
      (report.command !== undefined && run.command !== undefined && report.command !== run.command)
    ) {
      run = {
        id: report.id,
        at: report.at,
        startedBy: undefined,
        command: undefined,
        child: undefined,
      };
      runs.push(run);
      latest.set(report.id, run);
    }

    run.command ??= report.command;
    run.child ??= report.child;
  }

  return runs;
}

/** The session's launches, and the calls that may have launched but are not counted. */
export interface LaunchCalls {
  readonly launches: Launch[];
  readonly uncounted: UncountedLaunch[];
}

export function launchCalls(jsonl: string, operations: readonly ToolOperation[]): LaunchCalls {
  const lineOf = entryLines(jsonl);
  const runs = terminalRuns(jsonl, operations, lineOf);
  const claimed = new Set<TerminalRun>();
  const launches: Launch[] = [];
  const uncounted: UncountedLaunch[] = [];

  for (const operation of operations) {
    if (operation.tool !== "bg_start" && operation.tool !== "bash") continue;

    const recorded = argument(operation, "command");

    if (recorded === undefined) continue;

    const command = recorded.replace(CUT, "");
    const at = operation.entryId === undefined ? -1 : (lineOf.get(operation.entryId) ?? -1);

    // A top-level bg_start reports the run it started. A nested one does not, so the first later
    // run whose full command its recorded prefix opens is its run.
    const run =
      operation.tool !== "bg_start"
        ? undefined
        : (runs.find((candidate) => candidate.startedBy === operation) ??
          runs.find(
            (candidate) =>
              candidate.startedBy === undefined &&
              !claimed.has(candidate) &&
              candidate.at > at &&
              candidate.command?.startsWith(command) === true,
          ));

    if (run !== undefined) claimed.add(run);

    // A terminal's report holds the full command of a run whose recorded command is cut.
    const fullCommand = run?.command ?? command;
    const cut = CUT.test(recorded);
    const reported = [...operation.output.matchAll(CHILD_SESSION)].map((match) => match[1]);
    const commands = launchCommands(fullCommand);

    commands.forEach((launch, index) => {
      const child =
        reported[index] ?? (commands.length === 1 ? run?.child : undefined) ?? launch.resumed;

      const entry = operation.entryId ?? "-";

      // A call that failed, such as one the delegate guard refused, and started no child ran
      // no launch.
      if (child === undefined && !operation.succeeded) return;

      if (cut && child === undefined) {
        uncounted.push({ entry });

        return;
      }

      launches.push({
        entry,
        kind: launch.kind,
        role: launch.role,
        command: launch.text,
        child,
        childName: launch.childName,
        calledAt: operation.calledAt,
      });
    });
  }

  return { launches, uncounted };
}
