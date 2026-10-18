import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, suite, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Duration } from "effect";
import { TERM_GRACE } from "../process-group.ts";
import { e2eUnavailable } from "../../test/tmux.ts";

const launcher = path.resolve(import.meta.dirname, "../../../../.build/bin/pi-subagent");

const subagentExtension = path.resolve(import.meta.dirname, "../index.ts");

const STALLS_THEN_HANGS_ON_SHUTDOWN = `import { writeFileSync } from "node:fs";

export default function (pi) {
  pi.on("before_agent_start", () => {
    writeFileSync(process.env.TASK_STARTED, "");

    return new Promise(() => {});
  });
  pi.on("session_shutdown", () => new Promise(() => {}));
}
`;

const TASK_MARKER = `import { writeFileSync } from "node:fs";

export default function (pi) {
  pi.on("before_agent_start", () => {
    writeFileSync(process.env.TASK_STARTED, "");
  });
}
`;

const SESSION_MARKER = `import { writeFileSync } from "node:fs";

export default function (pi) {
  pi.on("session_start", () => {
    writeFileSync(process.env.DESCENDANT_STARTED, "");
  });
}
`;

const STARTS_A_DESCENDANT = `import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export default async function () {
  spawn("pi", ["--mode", "rpc", "--no-session", "--extension", process.env.SUBAGENT_EXTENSION, "--extension", process.env.EXTENSION_DIR + "/SESSION_MARKER.ts"], {
    stdio: ["pipe", "ignore", "ignore"],
  });

  while (!existsSync(process.env.DESCENDANT_STARTED)) await delay(50);
}
`;

const EXTENSIONS = {
  STALLS_THEN_HANGS_ON_SHUTDOWN,
  TASK_MARKER,
  SESSION_MARKER,
  STARTS_A_DESCENDANT,
};

const REFUSING_MODEL = JSON.stringify({
  providers: {
    refusing: {
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      apiKey: "unused",
      models: [{ id: "refusing" }],
    },
  },
});

function unavailable(): string | undefined {
  if (process.env.HERDR_ENV !== "1") return "the launcher opens its pane in a live herdr session";

  return e2eUnavailable();
}

function mentions(pid: string, root: string): boolean {
  try {
    return ["cmdline", "environ"].some((file) =>
      readFileSync(`/proc/${pid}/${file}`, "latin1").includes(root),
    );
  } catch {
    return false;
  }
}

/** Pi renames its process, so a run's processes are found by the scratch root in their environment. */
function processesUnder(root: string): number[] {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name) && mentions(name, root))
    .map(Number);
}

async function until(condition: () => boolean, deadlineMs: number) {
  const deadline = Date.now() + deadlineMs;

  while (!condition() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Each poll follows the previous one.
    await delay(100);
  }

  return condition();
}

suite("pi-subagent (real pi in a herdr pane)", { skip: unavailable() }, () => {
  const roots: string[] = [];

  after(async () => {
    for (const root of roots) {
      for (const pid of processesUnder(root)) process.kill(pid, "SIGKILL");
    }

    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function launch(piExtensions: readonly (keyof typeof EXTENSIONS)[]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-e2e-"));
    const runtime = path.join(root, "runtime");
    const agentDir = path.join(root, "agent");

    roots.push(root);
    await Promise.all([mkdir(runtime, { mode: 0o700 }), mkdir(agentDir, { mode: 0o700 })]);

    await Promise.all([
      writeFile(path.join(agentDir, "models.json"), REFUSING_MODEL),
      ...Object.entries(EXTENSIONS).map(([name, source]) =>
        writeFile(path.join(root, `${name}.ts`), source),
      ),
    ]);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXTENSION_DIR: root,
      DESCENDANT_STARTED: path.join(root, "descendant-started"),
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      SUBAGENT_EXTENSION: subagentExtension,
      TASK_STARTED: path.join(root, "task-started"),
      XDG_RUNTIME_DIR: runtime,
    };

    delete env.PI_SUBAGENT_DEPTH;
    delete env.PI_SUBAGENT_RUN;

    const run = spawn(
      launcher,
      [
        "--name",
        "subagent:e2e",
        "--model",
        "refusing/refusing",
        "--session-dir",
        path.join(root, "sessions"),
        "--extension",
        subagentExtension,
        ...piExtensions.flatMap((name) => ["--extension", path.join(root, `${name}.ts`)]),
      ],
      { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    run.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    run.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    run.stdin.end("Reply with OK.");

    const exited = new Promise<void>((resolve) => run.on("close", () => resolve()));

    return {
      root,
      run,
      exited,
      taskStarted: () => existsSync(env.TASK_STARTED ?? ""),
      hasExited: () => run.exitCode !== null || run.signalCode !== null,
      output: () =>
        `--- stdout ---\n${Buffer.concat(stdout).toString()}\n--- stderr ---\n${Buffer.concat(stderr).toString()}`,
    };
  }

  test("a SIGKILL during the launcher's SIGTERM grace leaves no pi whose session_shutdown hangs", async () => {
    const { root, run, exited, taskStarted, output } = await launch([
      "STALLS_THEN_HANGS_ON_SHUTDOWN",
    ]);

    assert.ok(await until(taskStarted, 60_000), `pi started the task:\n${output()}`);

    run.kill("SIGTERM");
    await delay(Duration.toMillis(TERM_GRACE) / 2);
    run.kill("SIGKILL");
    await exited;

    assert.ok(
      await until(() => processesUnder(root).length === 0, 10_000),
      "neither pi nor the pane child outlives the launcher",
    );
  });

  test("a descendant Pi that reaches session_start first leaves the task to pi", async () => {
    const { root, taskStarted, hasExited, output } = await launch([
      "STARTS_A_DESCENDANT",
      "TASK_MARKER",
    ]);

    assert.ok(await until(hasExited, 90_000), `the launcher exits:\n${output()}`);
    assert.ok(taskStarted(), `pi, not the descendant, started the task:\n${output()}`);
    assert.ok(
      await until(() => processesUnder(root).length === 0, 10_000),
      "the run leaves no process behind",
    );
  });
});
