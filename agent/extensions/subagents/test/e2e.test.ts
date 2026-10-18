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

  test("a SIGKILL during the launcher's SIGTERM grace leaves no pi whose session_shutdown hangs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-e2e-"));
    const runtime = path.join(root, "runtime");
    const agentDir = path.join(root, "agent");
    const hang = path.join(root, "hanging-shutdown.ts");
    const taskStarted = path.join(root, "task-started");

    roots.push(root);
    await Promise.all([
      mkdir(runtime, { mode: 0o700 }),
      mkdir(agentDir, { mode: 0o700 }),
      writeFile(hang, STALLS_THEN_HANGS_ON_SHUTDOWN),
    ]);
    await writeFile(path.join(agentDir, "models.json"), REFUSING_MODEL);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      TASK_STARTED: taskStarted,
      XDG_RUNTIME_DIR: runtime,
    };

    delete env.PI_SUBAGENT_DEPTH;
    delete env.PI_SUBAGENT_RUN;

    const run = spawn(
      launcher,
      [
        "--name",
        "subagent:shutdown-hang",
        "--model",
        "refusing/refusing",
        "--session-dir",
        path.join(root, "sessions"),
        "--extension",
        subagentExtension,
        "--extension",
        hang,
      ],
      { cwd: root, env, stdio: ["pipe", "ignore", "pipe"] },
    );

    const stderr: Buffer[] = [];

    run.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    run.stdin.end("Reply with OK.");

    const exited = new Promise<void>((resolve) => run.on("close", () => resolve()));

    assert.ok(
      await until(() => existsSync(taskStarted), 60_000),
      `pi started the task:\n${Buffer.concat(stderr).toString()}`,
    );

    run.kill("SIGTERM");
    await delay(Duration.toMillis(TERM_GRACE) / 2);
    run.kill("SIGKILL");
    await exited;

    assert.ok(
      await until(() => processesUnder(root).length === 0, 10_000),
      "neither pi nor the pane child outlives the launcher",
    );
  });
});
