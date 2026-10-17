#!/usr/bin/env bun

import os from "node:os";
import {
  Clock,
  Console,
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
import { herdr, platform } from "../herdr.ts";
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
  printOnlyReason,
  RunOutcome,
  runFiles,
  subagentName,
  TabId,
  type WorkspaceId,
} from "../launch.ts";

/** The hidden entry the child's pane runs. It loads the launcher's environment, then runs `pi`. */
const PANE_CHILD = "__pane-child";

/** A child that has not opened its Pi session by then is stuck, for example on a startup prompt. */
const STARTUP_TIMEOUT_MS = 60_000;

/** How much of pi's stderr the pane child keeps for the launcher to print. */
const STDERR_LIMIT = 64 * 1024;

/** What this process was started with, read once at the native boundary. */
interface Invocation {
  readonly args: readonly string[];
  readonly env: Environment;
  readonly cwd: string;
  /** The command that starts this program again: the compiled binary, or bun and this script. */
  readonly self: readonly string[];
  /** Where run directories go: `XDG_RUNTIME_DIR`, or the system temp directory. */
  readonly runtimeRoot: string;
  readonly uid: number;
}

class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

class UnsafeRuntimeRoot extends Data.TaggedError("UnsafeRuntimeRoot")<{ readonly root: string }> {
  override get message(): string {
    return `${this.root} lets other users rename entries in it, so it cannot hold a run directory. Set XDG_RUNTIME_DIR.`;
  }
}

class StdioError extends Data.TaggedError("StdioError")<{ readonly cause: Error }> {
  override get message(): string {
    return `could not write the report: ${this.cause.message}`;
  }
}

const PaneGetResponse = Schema.Struct({ result: Schema.Struct({ pane: HerdrPane }) });

const PaneListResponse = Schema.Struct({
  result: Schema.Struct({
    panes: Schema.Array(Schema.Struct({ pane_id: PaneId, cwd: Schema.String })),
  }),
});

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

/** A pane this launcher created, which it must close on every exit path. */
type ChildPane =
  | { readonly kind: "tab"; readonly tab: TabId; readonly pane: PaneId }
  | { readonly kind: "split"; readonly pane: PaneId };

/** How the pane child ended, as the launcher observes it. */
type ChildEnd =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "lost"; readonly reason: string };

/** Bun drops pending pipe writes on `process.exit`, so every write waits for its callback. */
const write = (stream: NodeJS.WriteStream, text: string) =>
  Effect.callback<void, StdioError>((resume) => {
    stream.write(text, (error) =>
      resume(error ? Effect.fail(new StdioError({ cause: error })) : Effect.void),
    );
  });

const log = Effect.fn("log")(function* (message: string) {
  const now = yield* DateTime.now;

  // Nothing useful follows a failed write to stderr, so a log line never fails its caller.
  yield* write(process.stderr, `pi-subagent ${DateTime.formatIso(now)} ${message}\n`).pipe(
    Effect.ignore,
  );
});

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Each pane opens in its run directory, which no other pane shares. If herdr creates a pane and
 * the call still fails, the directory is how the launcher finds the pane to close it.
 */
const closeStrays = Effect.fn("closeStrays")(
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
    Effect.tapError(() => closeStrays(runDirectory)),
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
    Effect.tapError(() => closeStrays(runDirectory)),
    Effect.catch((error) =>
      log(
        `could not split pane ${placement.target} (${error.message}); opening a tab instead`,
      ).pipe(Effect.andThen(createTab(workspace, runDirectory, name))),
    ),
  );
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

/**
 * Another user who can rename entries in the root could swap the run directory for their own
 * and read `launch.json`. A root the user or root owns, and others cannot write to without the
 * sticky bit, rules that out.
 */
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

const readInteger = Effect.fn("readInteger")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString(path).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Integer)));
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** One look at the run directory: has the child ended, been lost, or neither yet? */
const observeChild = Effect.fn("observeChild")(function* (
  files: ReturnType<typeof runFiles>,
  deadline: number,
) {
  const fs = yield* FileSystem.FileSystem;

  if (yield* fs.exists(files.exit)) {
    const exitCode = yield* readInteger(files.exit);

    return Option.some<ChildEnd>({ kind: "exited", exitCode });
  }

  const panePid = (yield* fs.exists(files.started))
    ? Option.some(yield* readInteger(files.started))
    : Option.none<number>();

  if (Option.isSome(panePid) && !isAlive(panePid.value)) {
    // The pane child writes `exit` and then exits, so `exit` may have landed after the check above.
    if (yield* fs.exists(files.exit)) return Option.none<ChildEnd>();

    return Option.some<ChildEnd>({
      kind: "lost",
      reason: `The pane child (pid ${panePid.value}) died without recording how pi exited.`,
    });
  }

  const now = yield* Clock.currentTimeMillis;

  if (now < deadline || (yield* fs.exists(files.claim))) return Option.none<ChildEnd>();

  if (Option.isNone(panePid)) {
    return Option.some<ChildEnd>({
      kind: "lost",
      reason: "The herdr pane never started the child within 60s.",
    });
  }

  return Option.some<ChildEnd>({
    kind: "lost",
    reason: "Pi did not open its session within 60s; it may be waiting on a startup prompt.",
  });
});

const awaitChild = Effect.fn("awaitChild")(function* (files: ReturnType<typeof runFiles>) {
  const deadline = (yield* Clock.currentTimeMillis) + STARTUP_TIMEOUT_MS;

  while (true) {
    const observed = yield* observeChild(files, deadline);

    if (Option.isSome(observed)) return observed.value;

    yield* Effect.sleep("100 millis");
  }
});

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

/** `pi --print` writes its stderr to the caller, so the launcher passes on what pi wrote in the pane. */
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

  return exitCodeFor(outcome);
});

const runPrint = Effect.fn("runPrint")(function* (
  args: readonly string[],
  stdin: "inherit" | "ignore",
) {
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

const runInHerdr = Effect.fn("runInHerdr")(function* (
  mode: Extract<Mode, { kind: "herdr" }>,
  invocation: Invocation,
) {
  const fs = yield* FileSystem.FileSystem;
  const { parseArgs } = yield* Effect.promise(() => import("@earendil-works/pi-coding-agent"));
  const parsed = parseArgs([...invocation.args]);
  const unsupported = printOnlyReason(parsed);

  if (unsupported !== undefined) {
    yield* log(`running pi --print, because ${unsupported}`);

    return yield* runPrint(invocation.args, "inherit");
  }

  // `pi --print` trims stdin and prompts nothing when it is empty.
  const task = (yield* Effect.promise(() => Bun.stdin.text())).trim();

  if (task === "") {
    yield* log("running pi --print, because stdin held no assignment");

    return yield* runPrint(invocation.args, "ignore");
  }

  const caller = yield* herdr(["pane", "get", mode.pane]).pipe(
    Effect.flatMap(decodeJson(PaneGetResponse)),
  );

  const workspace = caller.result.pane.workspace_id;

  const placement = placementFor({
    parentPane: caller.result.pane.pane_id,
    workspace,
    depth: mode.depth,
  });

  const name = subagentName(parsed.name);

  const runtimeRoot = yield* checkRuntimeRoot(invocation.runtimeRoot, invocation.uid);

  const runDirectory = yield* fs.makeTempDirectoryScoped({
    directory: runtimeRoot,
    prefix: "pi-subagent-",
  });

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

  const child = yield* Effect.acquireRelease(
    openPane(placement, workspace, runDirectory, name),
    closePane,
  );

  yield* log(`started ${name} in pane ${child.pane}`);
  yield* herdr([
    "pane",
    "run",
    child.pane,
    [...invocation.self, PANE_CHILD, runDirectory].map(shellQuote).join(" "),
  ]);

  const end = yield* awaitChild(files);

  yield* forwardStderr(files.stderr);

  if (end.kind === "lost") return yield* reportOutcome({ kind: "failed", reason: end.reason });

  yield* log(`child exited with code ${end.exitCode}`);

  return yield* readOutcome(files.outcome, end.exitCode).pipe(Effect.flatMap(reportOutcome));
}, Effect.scoped);

const writeAtomically = Effect.fn("writeAtomically")(function* (path: string, text: string) {
  const fs = yield* FileSystem.FileSystem;

  // The launcher polls for these files, so it must never see one half-written.
  yield* fs.writeFileString(`${path}.partial`, text);
  yield* fs.rename(`${path}.partial`, path);
});

const runPi = Effect.fn("runPi")(function* (
  files: ReturnType<typeof runFiles>,
  paneEnv: Environment,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const launch = yield* fs
    .readFileString(files.launch)
    .pipe(Effect.flatMap(decodeJson(ChildLaunch)));

  yield* fs.remove(files.launch);

  const handle = yield* spawner.spawn(
    ChildProcess.make("pi", launch.args, {
      cwd: launch.cwd,
      env: childEnv(launch.env, paneEnv),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "pipe",
      // The TUI must stay in the pane's foreground process group to read the terminal.
      detached: false,
    }),
  );

  const stderrFile = yield* fs.open(files.stderr, { flag: "a" });
  let kept = 0;

  // pi's stderr still reaches the pane; its first STDERR_LIMIT bytes also go to the launcher.
  const copying = yield* handle.stderr.pipe(
    Stream.runForEach((chunk) => {
      const part = chunk.subarray(0, Math.max(0, STDERR_LIMIT - kept));
      kept += part.length;

      return Effect.sync(() => process.stderr.write(chunk)).pipe(
        Effect.andThen(part.length > 0 ? stderrFile.write(part) : Effect.void),
      );
    }),
    Effect.ignore,
    Effect.forkScoped,
  );

  const exitCode = yield* handle.exitCode;

  // A process pi left behind can hold stderr open, so the copy gets a moment, not a promise.
  yield* Fiber.join(copying).pipe(Effect.timeout("1 second"), Effect.ignore);

  return exitCode;
}, Effect.scoped);

const runPaneChild = Effect.fn("runPaneChild")(function* (
  runDirectory: string,
  paneEnv: Environment,
) {
  const files = runFiles(runDirectory);

  yield* writeAtomically(files.started, String(process.pid));

  const exitCode = yield* runPi(files, paneEnv).pipe(
    Effect.catch((error) => Console.error(`pi-subagent: ${error.message}`).pipe(Effect.as(1))),
  );

  yield* writeAtomically(files.exit, String(exitCode));

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

  if (mode.kind === "print") return yield* runPrint(invocation.args, "inherit");

  return yield* runInHerdr(mode, invocation);
});

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

const compiled = Bun.main.startsWith("/$bunfs/");

const fiber = Effect.runFork(
  main({
    args: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    self: compiled ? [process.execPath] : [process.execPath, Bun.main],
    runtimeRoot: process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
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
    // Interrupting runs the scope's finalizers, which close the child's pane.
    Effect.runFork(Fiber.interrupt(fiber));
  });
}

fiber.addObserver((exit) => {
  if (signalExitCode !== undefined) process.exit(signalExitCode);

  process.exit(Exit.isSuccess(exit) ? exit.value : 1);
});
