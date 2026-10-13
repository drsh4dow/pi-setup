import assert from "node:assert/strict";
import { describe } from "node:test";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { e2eUnavailable, makePiRoot, repositoryExtension, testEffect } from "../../test/tmux.ts";

const services = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);

// The job outlasts the two model calls before the status reply, so its output
// can only reach the model through the settle wait rather than mid-run
// steering. The marker comes from the environment, so the model cannot echo it
// before the job finishes.
const PROMPT =
  'Use bg_start to run `sleep 15; echo "$PI_E2E_MARKER"`. Then reply with only a one-line status saying the job is running, and do not call any other tool.';

const printRun = Effect.fn("printRun")(function* (marker: string) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { root, cwd, agentDir } = yield* makePiRoot();

  const command = ChildProcess.make(
    "pi",
    [
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--extension",
      repositoryExtension("background-terminals"),
      PROMPT,
    ],
    {
      cwd,
      // Piped stdin would make pi wait for EOF before reading the prompt.
      stdin: "ignore",
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        PI_SKIP_VERSION_CHECK: "1",
        HERDR_ENV: "0",
        PI_E2E_MARKER: marker,
      },
      extendEnv: true,
    },
  );

  // stderr joins the output so provider and extension errors reach the assertion message.
  return yield* spawner
    .string(command, { includeStderr: true })
    .pipe(Effect.ensuring(fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore)));
}, Effect.provide(services));

describe("background-terminals (real pi --print)", { skip: e2eUnavailable() }, () => {
  testEffect("a print run waits for its background job and reports its output", function* () {
    const marker = `finished-${crypto.randomUUID().slice(0, 8)}`;
    const stdout = yield* printRun(marker);
    assert.ok(stdout.includes(marker), `final report lacks the job output ${marker}:\n${stdout}`);
  });
});
