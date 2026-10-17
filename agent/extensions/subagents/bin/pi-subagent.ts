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
import { closeAbandonedPanes, herdr, platform } from "../herdr.ts";
import { runPaneChild } from "./pane-child.ts";
import {
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
  RUN_DIRECTORY_PREFIX,
  type RunOutcome,
  runFiles,
  runtimeRoot,
  subagentName,
  TabId,
  treeLabel,
  type WorkspaceId,
} from "../launch.ts";

const PANE_CHILD = "__pane-child";

const SESSION_OPEN_TIMEOUT_MS = 60_000;

const LABEL_SOURCE = "pi:subagent";

interface Invocation {
  readonly args: readonly string[];
  readonly env: Environment;
  readonly cwd: string;
  readonly relaunchCommand: readonly string[];
  readonly runtimeRoot: string;
  readonly uid: number;
}

class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

class UnsafeRuntimeRoot extends Data.TaggedError("UnsafeRuntimeRoot")<{ readonly root: string }> {
  override get message(): string {
    return `${this.root} lets other users rename entries in it, so it cannot hold a run directory. Set XDG_RUNTIME_DIR.`;
  }
}

class SignalError extends Data.TaggedError("SignalError")<{
  readonly pid: number;
  readonly cause: unknown;
}> {
  override get message(): string {
    const reason = this.cause instanceof Error ? this.cause.message : "failed";

    return `kill -TERM -${this.pid}: ${reason}`;
  }
}

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

const Integer = Schema.NumberFromString.check(Schema.isInt());

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

const closePanesOfFinishedRuns = closeAbandonedPanes().pipe(
  Effect.flatMap((closed) =>
    Effect.forEach(closed, (pane) => log(`closed pane ${pane}, left by a finished run`)),
  ),
  Effect.catch((error) => log(`could not look for panes of finished runs: ${error.message}`)),
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

const readInteger = Effect.fn("readInteger")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString(path).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Integer)));
});

// Herdr runs a pane's command as its own process group, and pi stays in the pane child's group.
const stopPaneChild = Effect.fn("stopPaneChild")(
  function* (files: RunFiles) {
    const fs = yield* FileSystem.FileSystem;

    if ((yield* fs.exists(files.exit)) || !(yield* fs.exists(files.started))) return;

    const pid = yield* readInteger(files.started);

    if (!isAlive(pid)) return;

    yield* Effect.try({
      try: () => process.kill(-pid, "SIGTERM"),
      catch: (cause) => new SignalError({ pid, cause }),
    });
    yield* log(`sent SIGTERM to the pane child's process group ${pid}`);
  },
  Effect.catch((error) => log(`could not stop the pane child: ${error.message}`)),
);

// Closing the pane is what stops the child Pi; a signal to the launcher never reaches it.
const closePane = Effect.fn("closePane")(function* (child: ChildPane, files: RunFiles) {
  const [args, described] =
    child.kind === "tab"
      ? [["tab", "close", child.tab], `tab ${child.tab}`]
      : [["pane", "close", child.pane], `pane ${child.pane}`];

  yield* herdr(args).pipe(
    Effect.andThen(log(`closed ${described}`)),
    Effect.catch((error) =>
      log(`could not close ${described}: ${error.message}`).pipe(
        Effect.andThen(stopPaneChild(files)),
      ),
    ),
  );
});

const checkRuntimeRoot = Effect.fn("checkRuntimeRoot")(function* (root: string, uid: number) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(root);
  const owner = Option.getOrElse(info.uid, () => -1);
  const othersMayWrite = (info.mode & 0o022) !== 0;
  const sticky = (info.mode & 0o1000) !== 0;

  if (info.type !== "Directory" || (owner !== uid && owner !== 0) || (othersMayWrite && !sticky)) {
    return yield* new UnsafeRuntimeRoot({ root });
  }

  return root;
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

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
  name: string,
  task: string,
) {
  const fs = yield* FileSystem.FileSystem;

  yield* closePanesOfFinishedRuns;

  const caller = yield* herdr(["pane", "get", mode.pane]).pipe(
    Effect.flatMap(decodeJson(PaneGetResponse)),
  );

  const workspace = caller.result.pane.workspace_id;

  const placement = placementFor({
    parentPane: caller.result.pane.pane_id,
    workspace,
    depth: mode.depth,
  });

  const root = yield* checkRuntimeRoot(invocation.runtimeRoot, invocation.uid);

  const runDirectory = yield* fs.makeTempDirectoryScoped({
    directory: root,
    prefix: RUN_DIRECTORY_PREFIX,
  });

  const files = runFiles(runDirectory);

  // Finalizers run in reverse, so this copy runs after the pane closes and before the directory goes.
  const forwardOnce = yield* Effect.cached(forwardStderr(files.stderr));
  yield* Effect.addFinalizer(() => forwardOnce.pipe(Effect.ignore));

  const launch = yield* encodeLaunch({
    args: invocation.args,
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
    (opened) => closePane(opened, files),
  );

  yield* labelPane(child.pane, treeLabel(mode.depth, name));
  yield* log(`started ${name} in pane ${child.pane}`);
  yield* herdr([
    "pane",
    "run",
    child.pane,
    [...invocation.relaunchCommand, PANE_CHILD, runDirectory].map(shellQuote).join(" "),
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
) {
  const unsupported = printOnlyReason(parsed);

  if (unsupported !== undefined) {
    yield* log(`running pi --print, because ${unsupported}`);

    return yield* runPrint(invocation.args, "inherit");
  }

  // `pi --print` reads no assignment from a terminal.
  if (process.stdin.isTTY) {
    yield* log("running pi --print, because stdin is a terminal");

    return yield* runPrint(invocation.args, "inherit");
  }

  const assignment = yield* Effect.promise(() => Bun.stdin.text());

  // `pi --print` trims stdin and prompts nothing when it is empty.
  const task = assignment.trim();

  if (task === "") {
    yield* log("running pi --print, because stdin held no assignment");

    return yield* runPrint(invocation.args, "ignore");
  }

  const run = yield* runInPane(mode, invocation, subagentName(parsed.name), task);

  if (run.kind === "reported") return run.exitCode;

  yield* log(`running pi --print, because ${run.reason}`);

  return yield* runPrint(invocation.args, Stream.make(new TextEncoder().encode(assignment)));
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

  return yield* runInHerdr(mode, invocation, parsed);
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
