import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

export const ASSIGNMENT = "Reply with the report.";

const roots: string[] = [];

export const removeFakeRoots = () =>
  Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

export async function until(condition: () => boolean | Promise<boolean>, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs;

  // oxlint-disable-next-line no-await-in-loop -- Each poll follows the previous one.
  while (!(await condition()) && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Each poll follows the previous one.
    await delay(20);
  }

  return condition();
}

export async function fakeHerdr(behavior: FakePi) {
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
