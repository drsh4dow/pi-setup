#!/usr/bin/env bun

import os from "node:os";
import type { Args } from "@earendil-works/pi-coding-agent";
import {
  Clock,
  Data,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { CommandInput } from "effect/process/ChildProcess";
import { herdr, platform, sweepAbandonedRuns } from "../herdr.ts";
import { isAlive, stopProcessGroup } from "../process-group.ts";
import { runPaneChild } from "./pane-child.ts";
import {
  argsWithoutMessage,
  checkRuntimeRoot,
  ChildLaunch,
  ChildResult,
  type Environment,
  exitCodeFor,
  HerdrPane,
  type Mode,
  modeFrom,
  PaneId,
  PaneListResponse,
  type Placement,
  placementFor,
  printOnlyReason,
  readInteger,
  runDirectoryPrefix,
  type RunOutcome,
  runFiles,
  type RuntimeRoot,
  runtimeRoot,
  subagentName,
  TabId,
  treeLabel,
  type WorkspaceId,
} from "../launch.ts";

const PANE_CHILD = "__pane-child";

const SESSION_OPEN_TIMEOUT_MS = 60_000;

const LABEL_SOURCE = "pi:subagent";

const EXITED_PI_GROUP_GRACE = "1 second";

interface Invocation {
  readonly args: readonly string[];
  readonly env: Environment;
  readonly cwd: string;
  readonly relaunchCommand: readonly string[];
  readonly runtimeRoot: string;
  readonly uid: number;
  readonly pid: number;
}

class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

class StdioError extends Data.TaggedError("StdioError")<{ readonly cause: Error }> {
  override get message(): string {
    return `could not write the report: ${this.cause.message}`;
  }
}

const PaneGetResponse = Schema.Struct({ result: Schema.Struct({ pane: HerdrPane }) });

const TabCreateResponse = Schema.Struct({
  result: Schema.Struct({
    tab: Schema.Struct({ tab_id: TabId }),
    root_pane: Schema.Struct({ pane_id: PaneId }),
  }),
});

const PaneSplitResponse = Schema.Struct({
  result: Schema.Struct({ pane: Schema.Struct({ pane_id: PaneId }) }),
});

const decodeJson = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

const encodeLaunch = Schema.encodeEffect(Schema.fromJsonString(ChildLaunch));

type ChildPane =
  | { readonly kind: "tab"; readonly tab: TabId; readonly pane: PaneId }
  | { readonly kind: "split"; readonly pane: PaneId };

type ChildEnd =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "lost"; readonly reason: string };

type PaneRun =
  | { readonly kind: "reported"; readonly exitCode: number }
  | { readonly kind: "printInstead"; readonly reason: string };

type RunFiles = ReturnType<typeof runFiles>;

/** Bun drops pending pipe writes on `process.exit`, so every write waits for its callback. */
const write = (stream: NodeJS.WriteStream, text: string) =>
  Effect.callback<void, StdioError>((resume) => {
    stream.write(text, (error) =>
      resume(error ? Effect.fail(new StdioError({ cause: error })) : Effect.void),
    );
  });

const log = Effect.fn("log")(function* (message: string) {
  const now = yield* DateTime.now;

  yield* write(process.stderr, `pi-subagent ${DateTime.formatIso(now)} ${message}\n`).pipe(
    Effect.ignore,
  );
});

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

const closePanesOpenedIn = Effect.fn("closePanesOpenedIn")(
  function* (runDirectory: string) {
    const listed = yield* herdr(["pane", "list"]).pipe(
      Effect.flatMap(decodeJson(PaneListResponse)),
    );

    const strays = listed.result.panes.filter((pane) => pane.cwd === runDirectory);

    yield* Effect.forEach(strays, (pane) =>
      herdr(["pane", "close", pane.pane_id]).pipe(
        Effect.andThen(log(`closed stray pane ${pane.pane_id}`)),
      ),
    );
  },
  Effect.catch((error) => log(`could not look for stray panes: ${error.message}`)),
);

const sweepFinishedRuns = (root: RuntimeRoot, uid: number) =>
  sweepAbandonedRuns(root, uid).pipe(
    Effect.flatMap(({ removed, failed, closed }) =>
      Effect.all([
        Effect.forEach(removed, (run) => log(`removed ${run}, left by a killed launcher`)),
        Effect.forEach(failed, (error) => log(error.message)),
        Effect.forEach(closed, (pane) => log(`closed pane ${pane}, left by a finished run`)),
      ]),
    ),
    Effect.catch((error) => log(`could not look for finished runs: ${error.message}`)),
  );

const createTab = Effect.fn("createTab")(function* (
  workspace: WorkspaceId,
  runDirectory: string,
  name: string,
) {
  const created = yield* herdr([
    "tab",
    "create",
    "--workspace",
    workspace,
    "--cwd",
    runDirectory,
    "--label",
    `sub:${name}`,
    "--no-focus",
  ]).pipe(
    Effect.flatMap(decodeJson(TabCreateResponse)),
    Effect.tapError(() => closePanesOpenedIn(runDirectory)),
  );

  return {
    kind: "tab",
    tab: created.result.tab.tab_id,
    pane: created.result.root_pane.pane_id,
  } satisfies ChildPane;
});

const openPane = Effect.fn("openPane")(function* (
  placement: Placement,
  workspace: WorkspaceId,
  runDirectory: string,
  name: string,
) {
  if (placement.kind === "tab") return yield* createTab(workspace, runDirectory, name);

  return yield* herdr([
    "pane",
    "split",
    placement.target,
    "--direction",
    "down",
    "--cwd",
    runDirectory,
    "--no-focus",
  ]).pipe(
    Effect.flatMap(decodeJson(PaneSplitResponse)),
    Effect.map(
      (created) => ({ kind: "split", pane: created.result.pane.pane_id }) satisfies ChildPane,
    ),
    Effect.tapError(() => closePanesOpenedIn(runDirectory)),
    Effect.catch((error) =>
      log(
        `could not split pane ${placement.target} (${error.message}); opening a tab instead`,
      ).pipe(Effect.andThen(createTab(workspace, runDirectory, name))),
    ),
  );
});

const labelPane = Effect.fn("labelPane")(function* (pane: PaneId, label: string) {
  yield* herdr([
    "pane",
    "report-metadata",
    pane,
    "--source",
    LABEL_SOURCE,
    "--display-agent",
    label,
  ]).pipe(Effect.catch((error) => log(`could not label pane ${pane}: ${error.message}`)));
});

const stopPiGroup = Effect.fn("stopPiGroup")(
  function* (files: RunFiles) {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(files.started))) return;

    const group = yield* readInteger(files.started);
    const piExited = yield* fs.exists(files.exit);
    const stopped = yield* stopProcessGroup(group, piExited ? EXITED_PI_GROUP_GRACE : "0 millis");

    if (stopped === "survived") {
      yield* log(`pi's process group ${group} is still alive after SIGKILL`);
    } else if (stopped !== "exited") {
      yield* log(`stopped pi's process group ${group} with ${stopped}`);
    }
  },
  Effect.catch((error) => log(`could not stop pi's process group: ${error.message}`)),
);

const closePane = Effect.fn("closePane")(function* (child: ChildPane) {
  const [args, described] =
    child.kind === "tab"
      ? [["tab", "close", child.tab], `tab ${child.tab}`]
      : [["pane", "close", child.pane], `pane ${child.pane}`];

  yield* herdr(args).pipe(
    Effect.andThen(log(`closed ${described}`)),
    Effect.catchTag("HerdrError", (error) =>
      error.targetGone ? log(`${described} had already closed`) : Effect.fail(error),
    ),
    Effect.catch((error) => log(`could not close ${described}: ${error.message}`)),
  );
});

const observeChild = Effect.fn("observeChild")(function* (files: RunFiles, deadline: number) {
  const fs = yield* FileSystem.FileSystem;

  const panePid = (yield* fs.exists(files.started))
    ? Option.some(yield* readInteger(files.started))
    : Option.none<number>();

  const deadPanePid = Option.filter(panePid, (pid) => !isAlive(pid));

  if (yield* fs.exists(files.exit)) {
    const exitCode = yield* readInteger(files.exit);

    return Option.some<ChildEnd>({ kind: "exited", exitCode });
  }

  if (Option.isSome(deadPanePid)) {
    return Option.some<ChildEnd>({
      kind: "lost",
      reason: `The pane child (pid ${deadPanePid.value}) died without recording how pi exited.`,
    });
  }

  const now = yield* Clock.currentTimeMillis;

  if (now < deadline || (yield* fs.exists(files.claim))) return Option.none<ChildEnd>();

  if (Option.isNone(panePid)) {
    return Option.some<ChildEnd>({
      kind: "lost",
      reason: `The herdr pane never started the child within ${SESSION_OPEN_TIMEOUT_MS / 1000}s.`,
    });
  }

  return Option.some<ChildEnd>({
    kind: "lost",
    reason: `Pi did not open its session within ${SESSION_OPEN_TIMEOUT_MS / 1000}s; it may be waiting on a startup prompt.`,
  });
});

const awaitChild = Effect.fn("awaitChild")(function* (files: RunFiles) {
  const deadline = (yield* Clock.currentTimeMillis) + SESSION_OPEN_TIMEOUT_MS;

  while (true) {
    const observed = yield* observeChild(files, deadline);

    if (Option.isSome(observed)) return observed.value;

    yield* Effect.sleep("100 millis");
  }
});

const readResult = Effect.fn("readResult")(function* (path: string, exitCode: number) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(path))) {
    return {
      kind: "failed",
      reason: `pi exited with code ${exitCode} before the run settled.`,
    } satisfies ChildResult;
  }

  return yield* fs.readFileString(path).pipe(Effect.flatMap(decodeJson(ChildResult)));
});

const forwardStderr = Effect.fn("forwardStderr")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(path))) return;

  const text = yield* fs.readFileString(path);

  if (text !== "") yield* write(process.stderr, text);
});

const reportOutcome = Effect.fn("reportOutcome")(function* (outcome: RunOutcome) {
  switch (outcome.kind) {
    case "completed":
      yield* write(process.stdout, outcome.report);
      break;
    case "truncated":
      yield* write(process.stdout, outcome.report);
      yield* write(
        process.stderr,
        "Response was truncated: the model reached its output token limit.\n",
      );
      break;
    case "aborted":
      yield* write(process.stdout, outcome.report);
      yield* log("the child run was aborted");
      break;
    case "failed":
      yield* write(process.stderr, `${outcome.reason}\n`);
      break;
  }
});

const runPrint = Effect.fn("runPrint")(function* (args: readonly string[], stdin: CommandInput) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* spawner.exitCode(
    ChildProcess.make("pi", ["--print", ...args], {
      stdin,
      stdout: "inherit",
      stderr: "inherit",
      detached: false,
    }),
  );
});

const runInPane = Effect.fn("runInPane")(function* (
  mode: Extract<Mode, { kind: "herdr" }>,
  invocation: Invocation,
  childArgs: readonly string[],
  name: string,
  task: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* checkRuntimeRoot(invocation.runtimeRoot, invocation.uid);

  yield* sweepFinishedRuns(root, invocation.uid);

  const caller = yield* herdr(["pane", "get", mode.pane]).pipe(
    Effect.flatMap(decodeJson(PaneGetResponse)),
  );

  const workspace = caller.result.pane.workspace_id;

  const placement = placementFor({
    parentPane: caller.result.pane.pane_id,
    workspace,
    depth: mode.depth,
  });

  const runDirectory = yield* fs.makeTempDirectory({
    directory: root,
    prefix: runDirectoryPrefix(invocation.pid),
  });

  const files = runFiles(runDirectory);

  const removeRunDirectory = fs
    .remove(runDirectory, { recursive: true, force: true })
    .pipe(Effect.catch((error) => log(`could not remove ${runDirectory}: ${error.message}`)));

  yield* Effect.addFinalizer(() => removeRunDirectory);

  const forwardOnce = yield* Effect.cached(forwardStderr(files.stderr));
  yield* Effect.addFinalizer(() => forwardOnce.pipe(Effect.ignore));

  const launch = yield* encodeLaunch({
    launcherPid: invocation.pid,
    args: childArgs,
    cwd: invocation.cwd,
    env: {
      ...invocation.env,
      PI_SUBAGENT_RUN: runDirectory,
      PI_SUBAGENT_DEPTH: String(mode.depth),
    },
  });

  yield* fs.writeFileString(files.task, task, { mode: 0o600 });
  yield* fs.writeFileString(files.launch, launch, { mode: 0o600 });

  const child = yield* Effect.acquireRelease(
    openPane(placement, workspace, runDirectory, name),
    (opened) =>
      stopPiGroup(files).pipe(
        Effect.andThen(forwardOnce.pipe(Effect.ignore)),
        Effect.andThen(removeRunDirectory),
        Effect.andThen(closePane(opened)),
      ),
  );

  yield* labelPane(child.pane, treeLabel(mode.depth, name));
  yield* log(`started ${name} in pane ${child.pane}`);
  // `exec` leaves no shell in the pane to take keystrokes after pi exits, and herdr removes a pane
  // once its process exits.
  yield* herdr([
    "pane",
    "run",
    child.pane,
    `exec ${[...invocation.relaunchCommand, PANE_CHILD, runDirectory].map(shellQuote).join(" ")}`,
  ]);

  const end = yield* awaitChild(files);

  yield* forwardOnce;

  if (end.kind === "lost") {
    const failed = { kind: "failed", reason: end.reason } satisfies RunOutcome;

    yield* reportOutcome(failed);

    return { kind: "reported", exitCode: exitCodeFor(failed, 0) } satisfies PaneRun;
  }

  const result = yield* readResult(files.outcome, end.exitCode);

  if (result.kind === "printInstead") return result satisfies PaneRun;

  yield* reportOutcome(result);

  return { kind: "reported", exitCode: exitCodeFor(result, end.exitCode) } satisfies PaneRun;
}, Effect.scoped);

const runInHerdr = Effect.fn("runInHerdr")(function* (
  mode: Extract<Mode, { kind: "herdr" }>,
  invocation: Invocation,
  parsed: Args,
  parse: (args: string[]) => Args,
) {
  const unsupported = printOnlyReason(parsed);

  if (unsupported !== undefined) {
    yield* log(`running pi --print, because ${unsupported}`);

    return yield* runPrint(invocation.args, "inherit");
  }

  const [message] = parsed.messages;

  // `pi --print` reads no assignment from a terminal.
  if (message === undefined && process.stdin.isTTY) {
    yield* log("running pi --print, because stdin is a terminal");

    return yield* runPrint(invocation.args, "inherit");
  }

  const piped = process.stdin.isTTY ? "" : yield* Effect.promise(() => Bun.stdin.text());

  // `pi --print` prompts with stdin followed by the first message, trimmed, and prompts nothing
  // when that is empty.
  const task = `${piped}${message ?? ""}`.trim();

  if (task === "") {
    yield* log("running pi --print, because stdin held no assignment");

    return yield* runPrint(invocation.args, "ignore");
  }

  let childArgs = invocation.args;

  if (message !== undefined) {
    const withoutMessage = argsWithoutMessage(invocation.args, parse);

    if (Option.isNone(withoutMessage)) {
      yield* log("running pi --print, because no argument is the message alone");

      return yield* runPrint(invocation.args, Stream.make(new TextEncoder().encode(piped)));
    }

    childArgs = withoutMessage.value;
  }

  const run = yield* runInPane(mode, invocation, childArgs, subagentName(parsed.name), task);

  if (run.kind === "reported") return run.exitCode;

  yield* log(`running pi --print, because ${run.reason}`);

  return yield* runPrint(invocation.args, Stream.make(new TextEncoder().encode(piped)));
});

const main = Effect.fn("main")(function* (invocation: Invocation) {
  const [first, second] = invocation.args;

  if (first === PANE_CHILD && second !== undefined) {
    return yield* runPaneChild(second, invocation.env);
  }

  const { parseArgs } = yield* Effect.promise(() => import("@earendil-works/pi-coding-agent"));
  const parsed = parseArgs([...invocation.args]);

  if (parsed.print === true) {
    return yield* new UsageError({
      message: "pi-subagent always runs one assignment to a report; drop --print.",
    });
  }

  const mode = yield* modeFrom(invocation.env);

  if (mode.kind === "print") return yield* runPrint(invocation.args, "inherit");

  return yield* runInHerdr(mode, invocation, parsed, parseArgs);
});

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

const compiled = Bun.main.startsWith("/$bunfs/");

// Bun also reports a failed pipe write as an 'error' event, which kills the process before cleanup
// when nothing listens. The write's own callback carries the failure.
process.stdout.on("error", () => {});

process.stderr.on("error", () => {});

const fiber = Effect.runFork(
  main({
    args: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    relaunchCommand: compiled ? [process.execPath] : [process.execPath, Bun.main],
    runtimeRoot: runtimeRoot(process.env, os.tmpdir()),
    uid: process.getuid?.() ?? -1,
    pid: process.pid,
  }).pipe(
    Effect.catch((error) =>
      write(process.stderr, `pi-subagent: ${error.message}\n`).pipe(Effect.ignore, Effect.as(1)),
    ),
    Effect.provide(platform),
  ),
);

let signalExitCode: number | undefined;

for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
  // `on`, not `once`: pi's signal-exit dependency re-raises a signal it sees no other listener for.
  process.on(signal, () => {
    signalExitCode = exitCode;
    Effect.runFork(Fiber.interrupt(fiber));
  });
}

fiber.addObserver((exit) => {
  if (signalExitCode !== undefined) process.exit(signalExitCode);

  process.exit(Exit.isSuccess(exit) ? exit.value : 1);
});
