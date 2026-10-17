import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, suite, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const launcher = path.resolve(import.meta.dirname, "../../../../.build/bin/pi-subagent");

// Herdr runs a pane's command in its own session, and closing the pane hangs that session up.
// The launcher kills each herdr call's process group when the call returns, so `pane run` waits
// until the pane's command has left it.
const FAKE_HERDR = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_ROOT/herdr.log"
case "$1 $2" in
  "pane get") echo '{"result":{"pane":{"pane_id":"w1:p1","workspace_id":"w1"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t9"},"root_pane":{"pane_id":"w1:p9"}}}' ;;
  "pane run")
    setsid bash -c "$4" </dev/null >/dev/null 2>&1 &
    pane=$!
    until [ "$(ps -o sid= -p "$pane" | tr -d ' ')" = "$pane" ]; do sleep 0.01; done
    echo "$pane" > "$FAKE_ROOT/pane.pid"
    echo '{"result":{}}' ;;
  "tab close") kill -HUP -- "-$(cat "$FAKE_ROOT/pane.pid")"; echo '{"result":{}}' ;;
  *) echo "unexpected herdr call: $*" >&2; exit 1 ;;
esac
`;

const FAKE_PI = `#!/usr/bin/env bash
case "$FAKE_PI" in
  report) cp "$FAKE_ROOT/outcome.json" "$PI_SUBAGENT_RUN/outcome.json" ;;
  hang) touch "$PI_SUBAGENT_RUN/claim"; exec sleep 60 ;;
  orphan) kill -KILL "$PPID"; exec sleep 60 ;;
esac
`;

const roots: string[] = [];

async function fakeHerdr(behavior: "report" | "hang" | "orphan") {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-launcher-"));
  const bin = path.join(root, "bin");
  const runtime = path.join(root, "runtime");

  roots.push(root);
  await Promise.all([mkdir(bin), mkdir(runtime, { mode: 0o700 })]);
  await Promise.all([
    writeFile(path.join(root, "herdr.log"), ""),
    writeFile(path.join(bin, "herdr"), FAKE_HERDR, { mode: 0o755 }),
    writeFile(path.join(bin, "pi"), FAKE_PI, { mode: 0o755 }),
  ]);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: path.join(root, "herdr.sock"),
    HERDR_PANE_ID: "w1:p1",
    XDG_RUNTIME_DIR: runtime,
    FAKE_ROOT: root,
    FAKE_PI: behavior,
  };

  delete env.PI_SUBAGENT_DEPTH;
  delete env.PI_SUBAGENT_RUN;

  return {
    root,
    herdrCalls: async () => (await readFile(path.join(root, "herdr.log"), "utf8")).split("\n"),
    launch() {
      const child = spawn(launcher, ["--name", "subagent:alpha"], { env });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.end("Reply with the report.");

      const exit = new Promise<number | null>((resolve) => {
        child.on("close", (code) => resolve(code));
      });

      return {
        child,
        async result() {
          const code = await exit;

          return {
            code,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          };
        },
      };
    },
  };
}

suite("pi-subagent launcher", () => {
  after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

  test("a report over 64 KiB reaches stdout byte for byte", async () => {
    const herdr = await fakeHerdr("report");

    const report = Array.from(
      { length: 4000 },
      (_, line) => `line ${line} ${"x".repeat(40)}\n`,
    ).join("");

    assert.ok(report.length > 64 * 1024);
    await writeFile(
      path.join(herdr.root, "outcome.json"),
      JSON.stringify({ kind: "completed", report }),
    );

    const { code, stdout, stderr } = await herdr.launch().result();

    assert.equal(code, 0, stderr);
    assert.equal(stdout, report);
    assert.ok((await herdr.herdrCalls()).includes("tab close w1:t9"), "the pane is closed");
  });

  test("a pane child that dies without recording pi's exit fails the run at once", async () => {
    const herdr = await fakeHerdr("orphan");
    const started = Date.now();

    const { code, stderr } = await herdr.launch().result();

    assert.equal(code, 1, stderr);
    assert.match(stderr, /died without recording how pi exited/);
    assert.ok(Date.now() - started < 10_000, "the launcher does not wait for the startup bound");
    assert.ok((await herdr.herdrCalls()).includes("tab close w1:t9"), "the pane is closed");
  });

  test("SIGTERM closes the child's pane and exits 143", async () => {
    const herdr = await fakeHerdr("hang");
    const run = herdr.launch();
    const deadline = Date.now() + 10_000;

    const paneRuns = async () =>
      (await herdr.herdrCalls()).some((call) => call.startsWith("pane run"));

    // oxlint-disable-next-line no-await-in-loop -- Each poll follows the previous one.
    while (!(await paneRuns()) && Date.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- Each poll follows the previous one.
      await delay(20);
    }

    run.child.kill("SIGTERM");

    const { code, stderr } = await run.result();

    assert.equal(code, 143, stderr);
    assert.ok((await herdr.herdrCalls()).includes("tab close w1:t9"), "the pane is closed");
  });
});
