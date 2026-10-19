import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, suite, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const launcher = path.resolve(import.meta.dirname, "../../../../.build/bin/pi-subagent");

// Herdr types `pane run` into the pane's shell, which runs it in its own session; the trailing
// `exec sleep` stands in for that shell's prompt. Herdr removes a pane once its process exits, and
// closing a pane hangs its session up.
const FAKE_HERDR = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_ROOT/herdr.log"
case "$1 $2" in
  "pane get") echo '{"result":{"pane":{"pane_id":"w1:p1","workspace_id":"w1"}}}' ;;
  "pane list") cat "$FAKE_ROOT/panes.json" 2>/dev/null || echo '{"result":{"panes":[]}}' ;;
  "pane close") echo '{"result":{}}' ;;
  "pane report-metadata")
    if [ -n "$FAKE_KILL_ON_LABEL" ]; then kill -KILL "$PPID"; fi
    echo '{"result":{}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t9"},"root_pane":{"pane_id":"w1:p9"}}}' ;;
  "pane run")
    setsid bash -c "$4; exec sleep 600" </dev/null >/dev/null 2>&1 &
    pane=$!
    until [ "$(ps -o sid= -p "$pane" | tr -d ' ')" = "$pane" ] || ! kill -0 "$pane" 2>/dev/null; do
      sleep 0.01
    done
    echo "$pane" > "$FAKE_ROOT/pane.pid"
    echo '{"result":{}}' ;;
  "tab close")
    touch "$FAKE_ROOT/closing"
    sleep "\${FAKE_CLOSE_SLEEP:-0}"
    if [ -n "$FAKE_CLOSE_FAIL" ]; then echo "close failed" >&2; exit 1; fi
    pane=$(cat "$FAKE_ROOT/pane.pid")
    if ! kill -0 "$pane" 2>/dev/null; then
      echo '{"id":"cli:request","error":{"code":"tab_not_found","message":"tab not found"}}' >&2
      exit 1
    fi
    touch "$FAKE_ROOT/shell-at-close"
    kill -HUP -- "-$pane"; echo '{"result":{}}' ;;
  *) echo "unexpected herdr call: $*" >&2; exit 1 ;;
esac
`;

const FAKE_PI = `#!/usr/bin/env bash
echo $$ > "$FAKE_ROOT/pi.pid"
printf '%s\\n' "$@" > "$FAKE_ROOT/pi.args"
case "$FAKE_PI" in
  report)
    cp "$PI_SUBAGENT_RUN/task.md" "$FAKE_ROOT/task.md"
    cp "$FAKE_ROOT/outcome.json" "$PI_SUBAGENT_RUN/outcome.json" ;;
  hang)
    echo "pi was here" >&2
    touch "$PI_SUBAGENT_RUN/claim"
    exec sleep 60 ;;
  stubborn)
    trap '' TERM HUP
    touch "$PI_SUBAGENT_RUN/claim"
    exec sleep 60 ;;
  hangsOnShutdown)
    trap 'touch "$FAKE_ROOT/shutting-down"' TERM HUP
    touch "$PI_SUBAGENT_RUN/claim"
    while :; do sleep 0.05; done ;;
  orphan) kill -KILL "$PPID"; exec sleep 60 ;;
  noisy)
    for i in $(seq 1 4000); do printf 'ünïcødé line %05d ✓✓✓\\n' "$i"; done >&2
    cp "$FAKE_ROOT/outcome.json" "$PI_SUBAGENT_RUN/outcome.json" ;;
  failsAfterReport) cp "$FAKE_ROOT/outcome.json" "$PI_SUBAGENT_RUN/outcome.json"; exit 7 ;;
  handsBack)
    if [ "$1" = "--print" ]; then cat; exit 0; fi
    printf '{"kind":"printInstead","reason":"the test asks for it"}' > "$PI_SUBAGENT_RUN/outcome.json" ;;
esac
`;

type FakePi =
  | "report"
  | "hang"
  | "stubborn"
  | "hangsOnShutdown"
  | "orphan"
  | "noisy"
  | "failsAfterReport"
  | "handsBack";

interface Launch {
  readonly args?: readonly string[];
  readonly closeStdout?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly ownGroup?: boolean;
  readonly stdin?: string;
}

const ASSIGNMENT = "Reply with the report.";

const roots: string[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean | Promise<boolean>, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs;

  // oxlint-disable-next-line no-await-in-loop -- Each poll follows the previous one.
  while (!(await condition()) && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Each poll follows the previous one.
    await delay(20);
  }

  return condition();
}

async function fakeHerdr(behavior: FakePi) {
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

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: path.join(root, "herdr.sock"),
    HERDR_PANE_ID: "w1:p1",
    XDG_RUNTIME_DIR: runtime,
    FAKE_ROOT: root,
    FAKE_PI: behavior,
    FAKE_CLOSE_FAIL: "",
  };

  delete baseEnv.PI_SUBAGENT_DEPTH;
  delete baseEnv.PI_SUBAGENT_RUN;

  const piClaimed = async () => {
    const runs = await readdir(runtime);

    return runs.length > 0 && existsSync(path.join(runtime, runs[0], "claim"));
  };

  return {
    root,
    runtime,
    herdrCalls: async () => (await readFile(path.join(root, "herdr.log"), "utf8")).split("\n"),
    piPid: async () => Number(await readFile(path.join(root, "pi.pid"), "utf8")),
    async panePid() {
      const file = path.join(root, "pane.pid");

      assert.ok(await until(() => existsSync(file)), "herdr started the pane");

      return Number(await readFile(file, "utf8"));
    },
    writeOutcome: (outcome: { readonly kind: string; readonly report: string }) =>
      writeFile(path.join(root, "outcome.json"), JSON.stringify(outcome)),
    async waitForHangingPi() {
      assert.ok(await until(piClaimed), "pi claimed the run");
    },
    launch({
      args = [],
      closeStdout = false,
      env = {},
      ownGroup = false,
      stdin = ASSIGNMENT,
    }: Launch = {}) {
      const child = spawn(launcher, ["--name", "subagent:alpha", ...args], {
        env: { ...baseEnv, ...env },
        detached: ownGroup,
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      if (closeStdout) child.stdout.destroy();
      else child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.end(stdin);

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
            stderr: Buffer.concat(stderr),
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
    await herdr.writeOutcome({ kind: "completed", report });

    const { code, stdout, stderr } = await herdr.launch().result();

    assert.equal(code, 0, stderr.toString());
    assert.equal(stdout, report);
    assert.ok((await herdr.herdrCalls()).includes("tab close w1:t9"), "the pane is closed");
  });

  test("a pane child that dies without recording pi's exit fails the run at once", async () => {
    const herdr = await fakeHerdr("orphan");
    const started = Date.now();

    const { code, stderr } = await herdr.launch().result();

    assert.equal(code, 1, stderr.toString());
    assert.match(stderr.toString(), /died without recording how pi exited/);
    assert.ok(Date.now() - started < 10_000, "the launcher does not wait for the startup bound");
    assert.ok((await herdr.herdrCalls()).includes("tab close w1:t9"), "the pane is closed");
  });

  test("SIGTERM closes the child's pane, forwards pi's stderr, and exits 143", async () => {
    const herdr = await fakeHerdr("hang");
    const run = herdr.launch();

    await herdr.waitForHangingPi();
    run.child.kill("SIGTERM");

    const { code, stderr } = await run.result();

    assert.equal(code, 143, stderr.toString());
    assert.match(stderr.toString(), /pi was here/);
    assert.ok((await herdr.herdrCalls()).includes("tab close w1:t9"), "the pane is closed");
    assert.deepEqual(await readdir(herdr.runtime), [], "the run directory is removed");
  });

  test("a pane herdr fails to close still stops pi", async () => {
    const herdr = await fakeHerdr("hang");
    const run = herdr.launch({ env: { FAKE_CLOSE_FAIL: "1" } });

    await herdr.waitForHangingPi();
    run.child.kill("SIGTERM");

    const { code, stderr } = await run.result();

    assert.equal(code, 143, stderr.toString());
    assert.equal(isAlive(await herdr.piPid()), false, "pi is stopped");
  });

  test("a pi that outlives its pane child is stopped, even when herdr cannot close the pane", async () => {
    const herdr = await fakeHerdr("orphan");

    const { code, stderr } = await herdr.launch({ env: { FAKE_CLOSE_FAIL: "1" } }).result();

    assert.equal(code, 1, stderr.toString());
    assert.equal(isAlive(await herdr.piPid()), false, "pi is stopped");
    assert.deepEqual(await readdir(herdr.runtime), [], "the run directory is removed");
  });

  test("a pi that ignores SIGTERM and SIGHUP is killed before the launcher exits", async () => {
    const herdr = await fakeHerdr("stubborn");
    const run = herdr.launch();

    await herdr.waitForHangingPi();
    run.child.kill("SIGTERM");

    const { code, stderr } = await run.result();

    assert.equal(code, 143, stderr.toString());
    assert.equal(isAlive(await herdr.piPid()), false, "pi is stopped");
    assert.match(stderr.toString(), /stopped pi's process group \d+ with SIGKILL/);
  });

  test("a slow pane close leaves nothing behind when bg_kill escalates to SIGKILL at 2 s", async () => {
    const herdr = await fakeHerdr("hang");
    const run = herdr.launch({ env: { FAKE_CLOSE_SLEEP: "5" }, ownGroup: true });
    const group = run.child.pid;

    assert.ok(group !== undefined);
    await herdr.waitForHangingPi();
    process.kill(-group, "SIGTERM");
    await until(() => existsSync(path.join(herdr.root, "closing")), 2000);

    const pi = await herdr.piPid();
    const piStopped = !isAlive(pi);
    const runDirectories = await readdir(herdr.runtime);

    process.kill(-group, "SIGKILL");
    await run.result();

    assert.equal(piStopped, true, "pi is stopped before the pane closes");
    assert.deepEqual(runDirectories, [], "the run directory is removed before the pane closes");
    assert.ok(await until(() => !isAlive(-group)), "nothing in the launcher's group survives");
  });

  test("a SIGKILL to the launcher stops pi, removes the run directory, and ends the pane", async () => {
    const herdr = await fakeHerdr("hang");
    const run = herdr.launch();

    await herdr.waitForHangingPi();

    const [pi, pane] = await Promise.all([herdr.piPid(), herdr.panePid()]);

    run.child.kill("SIGKILL");
    await run.result();

    assert.ok(await until(() => !isAlive(pi), 5000), "pi is stopped");
    assert.ok(
      await until(async () => (await readdir(herdr.runtime)).length === 0, 5000),
      "the run directory is removed",
    );
    assert.ok(await until(() => !isAlive(-pane), 5000), "nothing in the pane survives");
  });

  test("a SIGKILL to the launcher during its SIGTERM grace stops a pi whose shutdown hangs", async () => {
    const herdr = await fakeHerdr("hangsOnShutdown");
    const run = herdr.launch();

    await herdr.waitForHangingPi();

    const [pi, pane] = await Promise.all([herdr.piPid(), herdr.panePid()]);

    run.child.kill("SIGTERM");
    assert.ok(
      await until(() => existsSync(path.join(herdr.root, "shutting-down")), 2000),
      "pi got SIGTERM",
    );
    run.child.kill("SIGKILL");
    await run.result();

    assert.ok(await until(() => !isAlive(pi), 5000), "pi is stopped");
    assert.ok(
      await until(async () => (await readdir(herdr.runtime)).length === 0, 5000),
      "the run directory is removed",
    );
    assert.ok(await until(() => !isAlive(-pane), 5000), "nothing in the pane survives");
  });

  test("closing the pane stops a pi whose shutdown hangs, and the launcher exits", async () => {
    const herdr = await fakeHerdr("hangsOnShutdown");
    const run = herdr.launch();

    await herdr.waitForHangingPi();

    const [pi, pane] = await Promise.all([herdr.piPid(), herdr.panePid()]);

    process.kill(pane, "SIGHUP");

    const ended = await Promise.race([
      run.result().then(() => true),
      delay(10_000).then(() => false),
    ]);

    if (!ended) run.child.kill("SIGKILL");

    assert.ok(ended, "the launcher exits");
    assert.equal(isAlive(pi), false, "pi is stopped");
  });

  test("a SIGKILL to the launcher's group stops a pi that ignores SIGTERM, and removes the run directory", async () => {
    const herdr = await fakeHerdr("stubborn");
    const run = herdr.launch({ ownGroup: true });
    const group = run.child.pid;

    assert.ok(group !== undefined);
    await herdr.waitForHangingPi();

    const [pi, pane] = await Promise.all([herdr.piPid(), herdr.panePid()]);

    process.kill(-group, "SIGKILL");
    await run.result();

    assert.ok(await until(() => !isAlive(pi), 5000), "pi is stopped");
    assert.ok(
      await until(async () => (await readdir(herdr.runtime)).length === 0, 5000),
      "the run directory is removed",
    );
    assert.ok(await until(() => !isAlive(-pane), 5000), "nothing in the pane survives");
  });

  test("a caller that closes stdout gets exit 1, and the launcher still cleans up", async () => {
    const herdr = await fakeHerdr("report");

    await herdr.writeOutcome({ kind: "completed", report: "REPORT\n" });

    const { code, stderr } = await herdr.launch({ closeStdout: true }).result();

    assert.equal(code, 1, stderr.toString());
    assert.ok((await herdr.herdrCalls()).includes("tab close w1:t9"), "the pane is closed");
    assert.deepEqual(await readdir(herdr.runtime), [], "the run directory is removed");
  });

  test("no shell is left in the pane after pi exits, and the pane herdr removed counts as closed", async () => {
    const herdr = await fakeHerdr("report");

    await herdr.writeOutcome({ kind: "completed", report: "REPORT\n" });

    const { code, stdout, stderr } = await herdr.launch().result();

    assert.equal(code, 0, stderr.toString());
    assert.equal(stdout, "REPORT\n");
    assert.equal(
      existsSync(path.join(herdr.root, "shell-at-close")),
      false,
      "no shell in the pane",
    );
    assert.match(stderr.toString(), /tab w1:t9 had already closed/);
    assert.deepEqual(await readdir(herdr.runtime), [], "the run directory is removed");
  });

  test("forwards pi's stderr up to 64 KiB of whole characters, then says the rest was dropped", async () => {
    const herdr = await fakeHerdr("noisy");

    await herdr.writeOutcome({ kind: "completed", report: "" });

    const { code, stderr } = await herdr.launch().result();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(stderr);

    const forwarded = text.slice(
      text.indexOf("ünïcødé line 00001"),
      text.indexOf("pi-subagent: pi wrote more than"),
    );

    assert.equal(code, 0, text);
    assert.match(
      text,
      /\npi-subagent: pi wrote more than 64 KiB to stderr; the rest is not forwarded\.\n/,
    );
    assert.ok(forwarded.startsWith("ünïcødé line 00001"), "forwarding starts with pi's first line");
    assert.ok(new TextEncoder().encode(forwarded).length <= 64 * 1024 + 1, "at most 64 KiB");
  });

  test("exits with pi's code when pi fails after it reported", async () => {
    const herdr = await fakeHerdr("failsAfterReport");

    await herdr.writeOutcome({ kind: "completed", report: "REPORT\n" });

    const { code, stdout } = await herdr.launch().result();

    assert.equal(stdout, "REPORT\n");
    assert.equal(code, 7);
  });

  test("a child that hands the run back reruns the assignment under pi --print", async () => {
    const herdr = await fakeHerdr("handsBack");

    const { code, stdout, stderr } = await herdr.launch().result();

    assert.equal(code, 0, stderr.toString());
    assert.equal(stdout, ASSIGNMENT);
    assert.match(stderr.toString(), /running pi --print, because the test asks for it/);
  });

  test("an assignment given as an argument runs in a pane, and pi does not get it again", async () => {
    const herdr = await fakeHerdr("report");

    await herdr.writeOutcome({ kind: "completed", report: "REPORT\n" });

    const { code, stdout, stderr } = await herdr
      .launch({ args: [ASSIGNMENT, "--thinking", "high"], stdin: "" })
      .result();

    const piArgs = (await readFile(path.join(herdr.root, "pi.args"), "utf8")).split("\n");

    assert.equal(code, 0, stderr.toString());
    assert.equal(stdout, "REPORT\n");
    assert.ok(
      (await herdr.herdrCalls()).some((call) => call.startsWith("tab create")),
      "the child got a tab",
    );
    assert.equal(await readFile(path.join(herdr.root, "task.md"), "utf8"), ASSIGNMENT);
    assert.deepEqual(piArgs.slice(1), ["--name", "subagent:alpha", "--thinking", "high", ""]);
  });

  test("an option value that reads --print is not the print flag", async () => {
    const herdr = await fakeHerdr("report");

    await herdr.writeOutcome({ kind: "completed", report: "REPORT\n" });

    const { code, stdout, stderr } = await herdr
      .launch({ args: ["--system-prompt", "--print"] })
      .result();

    assert.equal(code, 0, stderr.toString());
    assert.equal(stdout, "REPORT\n");
  });

  test("closes panes that herdr restored for finished runs, and only those", async () => {
    const herdr = await fakeHerdr("report");
    const live = await mkdtemp(path.join(herdr.runtime, `pi-subagent-${process.pid}-`));

    await herdr.writeOutcome({ kind: "completed", report: "" });
    await writeFile(
      path.join(herdr.root, "panes.json"),
      JSON.stringify({
        result: {
          panes: [
            { pane_id: "w1:p5", cwd: path.join(herdr.runtime, "pi-subagent-1-Ab12Cd") },
            { pane_id: "w1:p6", cwd: live },
            { pane_id: "w1:p7", cwd: herdr.root },
            { pane_id: "w1:p4", cwd: path.join(herdr.runtime, "pi-subagent-Xy34Zw") },
          ],
        },
      }),
    );

    const { code, stderr } = await herdr.launch().result();
    const calls = await herdr.herdrCalls();

    assert.equal(code, 0, stderr.toString());
    assert.ok(calls.includes("pane close w1:p5"), "the finished run's pane is closed");
    assert.ok(calls.includes("pane close w1:p4"), "an old-format run's pane is closed");
    assert.ok(!calls.includes("pane close w1:p6"), "a live run's pane stays");
    assert.ok(!calls.includes("pane close w1:p7"), "other panes stay");
  });

  test("the next run removes what a launcher killed before its pane child started left behind", async () => {
    const herdr = await fakeHerdr("report");

    await herdr.writeOutcome({ kind: "completed", report: "" });
    await herdr.launch({ env: { FAKE_KILL_ON_LABEL: "1" } }).result();

    const [orphaned] = await readdir(herdr.runtime);

    assert.ok(orphaned !== undefined, "the killed launcher left its run directory");
    await writeFile(
      path.join(herdr.root, "panes.json"),
      JSON.stringify({
        result: { panes: [{ pane_id: "w1:p9", cwd: path.join(herdr.runtime, orphaned) }] },
      }),
    );

    const { code, stderr } = await herdr.launch().result();

    assert.equal(code, 0, stderr.toString());
    assert.deepEqual(await readdir(herdr.runtime), [], "the run directory is removed");
    assert.ok((await herdr.herdrCalls()).includes("pane close w1:p9"), "the pane is closed");
  });

  test("the sweep removes only private directories of this user, and reports what it could not remove", async (t) => {
    const herdr = await fakeHerdr("report");
    const deadLauncher = spawnSync("true").pid;

    const run = (suffix: string) =>
      path.join(herdr.runtime, `pi-subagent-${deadLauncher}-${suffix}`);

    const target = path.join(herdr.root, "target");
    const locked = path.join(run("Fail12"), "locked");

    await Promise.all([
      mkdir(target),
      mkdir(run("Open12"), { mode: 0o755 }),
      mkdir(locked, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([symlink(target, run("Link12")), writeFile(path.join(locked, "file"), "")]);
    await chmod(locked, 0o500);
    t.after(() => chmod(locked, 0o700));
    await herdr.writeOutcome({ kind: "completed", report: "" });

    const { code, stderr } = await herdr.launch().result();

    assert.equal(code, 0, stderr.toString());
    assert.ok(existsSync(run("Open12")), "a directory others can read stays");
    assert.ok(existsSync(run("Link12")), "a symlink stays");
    assert.ok(existsSync(target), "a symlink's target stays");
    assert.match(stderr.toString(), new RegExp(`could not remove ${run("Fail12")}`));
  });

  test("an unsafe runtime root fails the run before any sweep", async () => {
    const herdr = await fakeHerdr("report");
    const abandoned = path.join(herdr.runtime, `pi-subagent-${spawnSync("true").pid}-Ab12Cd`);

    await mkdir(abandoned, { mode: 0o700 });
    await chmod(herdr.runtime, 0o777);

    const { code, stderr } = await herdr.launch().result();

    assert.notEqual(code, 0);
    assert.match(stderr.toString(), /lets other users rename entries in it/);
    assert.ok(existsSync(abandoned), "the sweep did not run");
  });

  test("closes a live pane whose run directory was removed", async () => {
    const herdr = await fakeHerdr("report");

    await herdr.writeOutcome({ kind: "completed", report: "" });
    await writeFile(
      path.join(herdr.root, "panes.json"),
      JSON.stringify({
        result: {
          panes: [
            {
              pane_id: "w1:p8",
              cwd: `${path.join(herdr.runtime, "pi-subagent-1-Ef56Gh")} (deleted)`,
            },
          ],
        },
      }),
    );

    const { code, stderr } = await herdr.launch().result();

    assert.equal(code, 0, stderr.toString());
    assert.ok((await herdr.herdrCalls()).includes("pane close w1:p8"), "the pane is closed");
  });
});
