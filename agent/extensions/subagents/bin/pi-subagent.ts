#!/usr/bin/env bun

import os from "node:os";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
  Console,
  Data,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Schedule,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { herdr } from "../herdr.ts";
import {
  ChildLaunch,
  childEnv,
  type Environment,
  exitCodeFor,
  HerdrPane,
  type Mode,
  modeFrom,
  PaneId,
  type Placement,
  placementFor,
  RunOutcome,
  runFiles,
  subagentName,
  TabId,
} from "../launch.ts";

/** The hidden entry the child's pane runs. It loads the launcher's environment, then runs `pi`. */
const PANE_CHILD = "__pane-child";

/** What this process was started with, read once at the native boundary. */
interface Invocation {
  readonly args: readonly string[];
  readonly env: Environment;
  readonly cwd: string;
  readonly self: string;
  readonly runtimeDirectory: string;
}

class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

class ChildPaneGone extends Data.TaggedError("ChildPaneGone")<{
  readonly pane: PaneId;
  readonly cause: Effect.Error<ReturnType<typeof herdr>>;
}> {
  override get message(): string {
    return `child pane ${this.pane} closed before the run settled (${this.cause.message})`;
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

const ExitCode = Schema.NumberFromString.check(Schema.isInt());

const decodeJson = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

const encodeLaunch = Schema.encodeEffect(Schema.fromJsonString(ChildLaunch));

/** A pane this launcher created, which it must close on every exit path. */
type ChildPane =
  | { readonly kind: "tab"; readonly tab: TabId; readonly pane: PaneId }
  | { readonly kind: "split"; readonly pane: PaneId };

const log = Effect.fn("log")(function* (message: string) {
  const now = yield* DateTime.now;

  yield* Console.error(`pi-subagent ${DateTime.formatIso(now)} ${message}`);
});

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

const openPane = Effect.fn("openPane")(function* (placement: Placement, cwd: string, name: string) {
  if (placement.kind === "tab") {
    const created = yield* herdr([
      "tab",
      "create",
      "--workspace",
      placement.workspace,
      "--cwd",
      cwd,
      "--label",
      `sub:${name}`,
      "--no-focus",
    ]).pipe(Effect.flatMap(decodeJson(TabCreateResponse)));

    return {
      kind: "tab",
      tab: created.result.tab.tab_id,
      pane: created.result.root_pane.pane_id,
    } satisfies ChildPane;
  }

  const created = yield* herdr([
    "pane",
    "split",
    placement.target,
    "--direction",
    "down",
    "--cwd",
    cwd,
    "--no-focus",
  ]).pipe(Effect.flatMap(decodeJson(PaneSplitResponse)));

  return { kind: "split", pane: created.result.pane.pane_id } satisfies ChildPane;
});

// Closing the pane is what stops the child Pi; a signal to the launcher never reaches it.
const closePane = Effect.fn("closePane")(function* (child: ChildPane) {
  const [args, described] =
    child.kind === "tab"
      ? [["tab", "close", child.tab], `tab ${child.tab}`]
      : [["pane", "close", child.pane], `pane ${child.pane}`];

  yield* herdr(args).pipe(
    Effect.andThen(log(`closed ${described}`)),
    Effect.catch((error) => log(`could not close ${described}: ${error.message}`)),
  );
});

const makeRunDirectory = Effect.fn("makeRunDirectory")(function* (runtimeDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const base = `${runtimeDirectory}/pi-subagent`;

  yield* fs.makeDirectory(base, { recursive: true, mode: 0o700 });

  return yield* fs.makeTempDirectoryScoped({ directory: base });
});

const waitForExit = Effect.fn("waitForExit")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs
    .exists(path)
    .pipe(Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (exists) => exists }));

  return yield* fs.readFileString(path).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ExitCode)));
});

/** Fails once herdr no longer knows the pane, so a pane closed by hand does not hang the launcher. */
const watchPane = (pane: PaneId) =>
  herdr(["pane", "get", pane]).pipe(
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever,
    Effect.mapError((cause) => new ChildPaneGone({ pane, cause })),
  );

const readOutcome = Effect.fn("readOutcome")(function* (path: string, exitCode: number) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(path))) {
    return {
      kind: "failed",
      reason: `pi exited with code ${exitCode} before the run settled.`,
    } satisfies RunOutcome;
  }

  return yield* fs.readFileString(path).pipe(Effect.flatMap(decodeJson(RunOutcome)));
});

const writeReport = (report: string) =>
  Effect.sync(() => {
    if (report !== "") process.stdout.write(`${report}\n`);
  });

const reportOutcome = Effect.fn("reportOutcome")(function* (outcome: RunOutcome) {
  switch (outcome.kind) {
    case "completed":
      yield* writeReport(outcome.report);
      break;
    case "aborted":
      yield* writeReport(outcome.report);
      yield* log("the child run was aborted");
      break;
    case "failed":
      yield* Console.error(outcome.reason);
      break;
  }

  return exitCodeFor(outcome);
});

const runInHerdr = Effect.fn("runInHerdr")(function* (
  mode: Extract<Mode, { kind: "herdr" }>,
  invocation: Invocation,
) {
  const fs = yield* FileSystem.FileSystem;
  const task = yield* Effect.promise(() => Bun.stdin.text());

  if (task.trim() === "") {
    return yield* new UsageError({
      message: "pi-subagent reads the assignment from stdin, and stdin was empty.",
    });
  }

  const caller = yield* herdr(["pane", "get", mode.pane]).pipe(
    Effect.flatMap(decodeJson(PaneGetResponse)),
  );

  const placement = placementFor({
    parentPane: caller.result.pane.pane_id,
    workspace: caller.result.pane.workspace_id,
    depth: mode.depth,
  });

  const name = subagentName(invocation.args);
  const runDirectory = yield* makeRunDirectory(invocation.runtimeDirectory);
  const files = runFiles(runDirectory);

  const launch = yield* encodeLaunch({
    args: invocation.args,
    cwd: invocation.cwd,
    env: {
      ...invocation.env,
      PI_SUBAGENT_RUN: runDirectory,
      PI_SUBAGENT_NAME: name,
      PI_SUBAGENT_DEPTH: String(mode.depth),
    },
  });

  yield* fs.writeFileString(files.task, task, { mode: 0o600 });
  yield* fs.writeFileString(files.launch, launch, { mode: 0o600 });

  const child = yield* Effect.acquireRelease(openPane(placement, invocation.cwd, name), closePane);

  yield* log(`started ${name} in pane ${child.pane}`);
  yield* herdr([
    "pane",
    "run",
    child.pane,
    `${shellQuote(invocation.self)} ${PANE_CHILD} ${shellQuote(runDirectory)}`,
  ]);

  const exitCode = yield* Effect.raceFirst(waitForExit(files.exit), watchPane(child.pane));

  yield* log(`child exited with code ${exitCode}`);

  return yield* readOutcome(files.outcome, exitCode).pipe(Effect.flatMap(reportOutcome));
}, Effect.scoped);

const runPrint = Effect.fn("runPrint")(function* (args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* spawner.exitCode(
    ChildProcess.make("pi", ["--print", ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      detached: false,
    }),
  );
});

const writeExitCode = Effect.fn("writeExitCode")(function* (path: string, exitCode: number) {
  const fs = yield* FileSystem.FileSystem;

  // The launcher polls for this file, so it must never see it half-written.
  yield* fs.writeFileString(`${path}.partial`, String(exitCode));
  yield* fs.rename(`${path}.partial`, path);
});

const runPaneChild = Effect.fn("runPaneChild")(function* (
  runDirectory: string,
  paneEnv: Environment,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const files = runFiles(runDirectory);

  const exitCode = yield* Effect.gen(function* () {
    const launch = yield* fs
      .readFileString(files.launch)
      .pipe(Effect.flatMap(decodeJson(ChildLaunch)));

    yield* fs.remove(files.launch);

    return yield* spawner.exitCode(
      ChildProcess.make("pi", launch.args, {
        cwd: launch.cwd,
        env: childEnv(launch.env, paneEnv),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        // The TUI must stay in the pane's foreground process group to read the terminal.
        detached: false,
      }),
    );
  }).pipe(
    Effect.catch((error) => Console.error(`pi-subagent: ${error.message}`).pipe(Effect.as(1))),
  );

  yield* writeExitCode(files.exit, exitCode);

  return exitCode;
});

const main = Effect.fn("main")(function* (invocation: Invocation) {
  const [first, second] = invocation.args;

  if (first === PANE_CHILD && second !== undefined) {
    return yield* runPaneChild(second, invocation.env);
  }

  if (invocation.args.some((arg) => arg === "--print" || arg === "-p")) {
    return yield* new UsageError({
      message: "pi-subagent always runs one assignment to a report; drop --print.",
    });
  }

  const mode = yield* modeFrom(invocation.env);

  if (mode.kind === "print") return yield* runPrint(invocation.args);

  return yield* runInHerdr(mode, invocation);
});

const fileSystem = BunFileSystem.layer;

const services = Layer.mergeAll(
  fileSystem,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(fileSystem, BunPath.layer))),
);

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

const fiber = Effect.runFork(
  main({
    args: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    self: process.execPath,
    runtimeDirectory: process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
  }).pipe(
    Effect.catch((error) => Console.error(`pi-subagent: ${error.message}`).pipe(Effect.as(1))),
    Effect.provide(services),
  ),
);

let signalExitCode: number | undefined;

for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
  process.once(signal, () => {
    signalExitCode = exitCode;
    // Interrupting runs the scope's finalizers, which close the child's pane.
    Effect.runFork(Fiber.interrupt(fiber));
  });
}

fiber.addObserver((exit) => {
  if (signalExitCode !== undefined) process.exit(signalExitCode);

  process.exit(Exit.isSuccess(exit) ? exit.value : 1);
});
