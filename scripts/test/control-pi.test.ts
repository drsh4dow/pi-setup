import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

const controlPi = new URL(
  "../../.agents/skills/verify-pi-setup/scripts/control-pi",
  import.meta.url,
).pathname;

// A stand-in for tmux, which CI does not install. The run's pane exists while $TMUX_STUB/pane
// does, and that file holds "alive" or "dead". capture-pane prints $TMUX_STUB/screen, and the
// pane's PID is $TMUX_STUB/pane_pid when a test started a Pi process under it. The socket's
// other session names are the lines of $TMUX_STUB/sessions, which has-session finds only by the
// exact target "=NAME:".
const stubTmux = `#!/usr/bin/env bash
while [[ \${1:-} == -L ]]; do shift 2; done
command=\${1:-}
case $command in
list-sessions) exec cat "$TMUX_STUB/sessions" 2>/dev/null ;;
has-session)
  target=\${3:-}
  if [[ $target == =*: ]]; then
    grep -qxF -- "\${target:1:-1}" "$TMUX_STUB/sessions" 2>/dev/null
    exit
  fi
  ;;
esac
[[ -f $TMUX_STUB/pane ]] || exit 1
case $command in
list-panes)
  if [[ $* == *pane_dead* ]]; then
    [[ $(cat "$TMUX_STUB/pane") == dead ]] && echo 1 || echo 0
  else
    cat "$TMUX_STUB/pane_pid" 2>/dev/null || echo 999999999
  fi
  ;;
capture-pane) cat "$TMUX_STUB/screen" 2>/dev/null || true ;;
send-keys) printf '%s\\n' "$*" >>"$TMUX_STUB/keys" ;;
esac
`;

type Pane = "none" | "alive" | "dead";

let runs = 0;

// One run of control-pi against a stub tmux, with its scratch state under a fresh temp dir.
function harness(t: TestContext, run = `control-pi-test-${process.pid}-${++runs}`) {
  const root = mkdtempSync(join(tmpdir(), "control-pi-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const stub = join(root, "tmux-stub");
  mkdirSync(bin);
  mkdirSync(stub);
  writeFileSync(join(bin, "tmux"), stubTmux);
  chmodSync(join(bin, "tmux"), 0o755);

  const scratch = join(root, "verify-pi-setup", run);
  const sessions = join(scratch, "sessions");

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: root,
    HOME: root,
    TMUX_STUB: stub,
  };

  return {
    run,
    scratch,
    sessions,
    env,
    // A launched run: scratch state, a session directory, and a pane in the given state.
    launch(pane: Pane = "alive") {
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(scratch, "pi.stderr.log"), "pi: fatal: the stderr of this run\n");
      this.pane(pane);
    },
    pane(state: Pane) {
      if (state === "none") rmSync(join(stub, "pane"), { force: true });
      else writeFileSync(join(stub, "pane"), state);
    },
    screen(text: string) {
      writeFileSync(join(stub, "screen"), text);
    },
    tmuxSessions(...names: string[]) {
      writeFileSync(join(stub, "sessions"), names.map((name) => `${name}\n`).join(""));
    },
    // Starts a process named pi, tagged with the run, under a pane shell that is not tagged,
    // as tmux runs `env VERIFY_PI_SETUP_RUN=... pi` in the pane.
    pi() {
      const pi = join(root, "pi");
      symlinkSync("/bin/sleep", pi);

      const shell = spawn("bash", ["-c", `VERIFY_PI_SETUP_RUN=${run} ${pi} 30 & wait`], {
        detached: true,
        stdio: "ignore",
      });

      const { pid } = shell;
      assert.ok(pid !== undefined, "the pane shell started");
      t.after(() => process.kill(-pid));
      writeFileSync(join(stub, "pane_pid"), `${pid}\n`);
    },
    touch(file: string, secondsAgo: number) {
      const time = Date.now() / 1000 - secondsAgo;
      utimesSync(join(sessions, file), time, time);
    },
    append(file: string, ...entries: object[]) {
      appendFileSync(
        join(sessions, file),
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      );
    },
    cp(...args: string[]) {
      const started = Date.now();
      const result = spawnSync(controlPi, args, { encoding: "utf8", env });

      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        seconds: (Date.now() - started) / 1000,
      };
    },
    // Starts control-pi and resolves when it exits, so a test can change state mid-wait.
    cpAsync(...args: string[]) {
      const started = Date.now();
      const child = spawn(controlPi, args, { env });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      return new Promise<{ status: number | null; stderr: string; seconds: number }>((resolve) => {
        child.on("exit", (status) =>
          resolve({ status, stderr, seconds: (Date.now() - started) / 1000 }),
        );
      });
    },
  };
}

const header = { type: "session", version: 3, id: "s1" };

const system = { type: "message", message: { role: "system", content: "" } };

const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });

const assistant = (stopReason: string) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text: stopReason }], stopReason },
});

const toolResult = { type: "message", message: { role: "toolResult", content: [] } };

// A reply cut off by the output limit inside a tool call. Pi fails the call and asks again.
const truncatedToolCall = {
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ec" } }],
    stopReason: "length",
  },
};

const jobResult = {
  type: "custom_message",
  customType: "background-terminal-results",
  content: "bt-1 done",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a run id with a dot is refused at bind time, naming the allowed characters", (t) => {
  const h = harness(t);

  for (const command of ["launch", "stop"]) {
    const result = h.cp(command, "r.1");

    assert.equal(result.status, 1, `${command}: ${result.stderr}`);
    assert.equal(
      result.stderr,
      "control-pi: invalid run id 'r.1': use only letters, digits, '_' and '-'; tmux reads '.' and ':' in a target as separators\n",
    );
  }
});

test("list shows a valid run and flags a leftover run id it cannot bind, with what to do", (t) => {
  const h = harness(t);
  h.launch("dead");
  const leftover = join(dirname(h.scratch), "r.1");
  mkdirSync(leftover);

  const result = h.cp("list");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `${h.run} dead   \n` +
      `r.1 invalid ${leftover}: stop refuses this id; remove the directory by hand\n`,
  );
});

test("a subcommand given an empty run id says the run id is missing", (t) => {
  const h = harness(t);

  for (const command of ["stop", "doctor"]) {
    const result = h.cp(command, "");

    assert.equal(result.status, 1, command);
    assert.equal(result.stderr, "control-pi: missing RUN_ID\n", command);
  }
});

test("list gives the commands that end a dotted leftover's tagged processes and tmux session", async (t) => {
  const h = harness(t);
  const withDirectory = `${h.run}.1`;
  const sessionOnly = `${h.run}.2`;
  const directory = join(dirname(h.scratch), withDirectory);
  mkdirSync(directory, { recursive: true });
  h.tmuxSessions(`vps-${withDirectory}`, `vps-${sessionOnly}`, "vps-valid-run", "unrelated");

  const pi = spawn("sleep", ["30"], {
    env: { ...process.env, VERIFY_PI_SETUP_RUN: withDirectory },
    stdio: "ignore",
  });

  t.after(() => pi.kill());
  await sleep(200);

  const result = h.cp("list");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    `${withDirectory} invalid ${directory}: stop refuses this id; remove the directory by hand\n` +
      `  it still holds its Pi or its tmux session; end them with: kill ${pi.pid}; tmux -L verify-pi-setup kill-session -t =vps-${withDirectory}:\n` +
      `${sessionOnly} invalid tmux session vps-${sessionOnly}: stop refuses this id\n` +
      `  it still holds its Pi or its tmux session; end them with: tmux -L verify-pi-setup kill-session -t =vps-${sessionOnly}:\n`,
  );
});

test("list skips a session named only vps- and still reports the sessions after it", (t) => {
  const h = harness(t);
  h.tmuxSessions("vps-", `vps-${h.run}.1`);

  const result = h.cp("list");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `${h.run}.1 invalid tmux session vps-${h.run}.1: stop refuses this id\n` +
      `  it still holds its Pi or its tmux session; end them with: tmux -L verify-pi-setup kill-session -t =vps-${h.run}.1:\n`,
  );
});

test("every wait on a run that was never launched says the run does not exist, not that Pi exited", (t) => {
  const h = harness(t);

  for (const args of [
    ["wait", h.run, "x", "2"],
    ["wait-turn", h.run, "2"],
    ["wait-idle", h.run, "2"],
  ]) {
    const result = h.cp(...args);
    assert.equal(result.status, 1, args[0]);
    assert.match(result.stderr, new RegExp(`run ${h.run} does not exist`), args[0]);
    assert.doesNotMatch(result.stderr, /Pi exited/, args[0]);
    assert.ok(result.seconds < 1.5, `${args[0]} failed at once`);
  }
});

test("a wait on a run with scratch state but no tmux session names both causes, launching or killed", (t) => {
  const h = harness(t);
  h.launch("none");

  const result = h.cp("wait", h.run, "x", "2");

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`run ${h.run} has scratch state but no tmux session`));
  assert.match(result.stderr, /still launching, or its tmux session was killed/);
  assert.doesNotMatch(result.stderr, /Pi exited/);
});

test("a wait on a run whose Pi already exited reports Pi exited with its stderr", (t) => {
  const h = harness(t);
  h.launch("dead");

  const result = h.cp("wait-turn", h.run, "2");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pi exited/);
  assert.match(result.stderr, /the stderr of this run/);
});

test("every wait whose Pi exits mid-wait reports Pi exited with its stderr", async (t) => {
  const waits = [["wait", "never on screen"], ["wait-turn"], ["wait-idle"]].map(async (args) => {
    const h = harness(t);
    h.launch();
    h.screen("still working\n");
    h.append("s.jsonl", header, system, user("first"), assistant("toolUse"));
    h.cp("send", h.run, "queued");

    const waiting = h.cpAsync(args[0], h.run, ...args.slice(1), "10");
    await sleep(700);
    h.pane("dead");

    return { wait: args[0], result: await waiting };
  });

  for (const { wait, result } of await Promise.all(waits)) {
    assert.equal(result.status, 1, wait);
    assert.match(result.stderr, /Pi exited while waiting for/, wait);
    assert.match(result.stderr, /the stderr of this run/, wait);
  }
});

test("a screen wait returns on a string the pane shows", (t) => {
  const h = harness(t);
  h.launch();
  h.screen("Fast mode disabled.\n0.0%/1.0M\n");

  const result = h.cp("wait", h.run, "Fast mode disabled\\.", "5");

  assert.equal(result.status, 0);
});

test("path RUN sessions prints the directory Pi writes its session file in", (t) => {
  const h = harness(t);

  const result = h.cp("path", h.run, "sessions");

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${h.sessions}\n`);
});

test("wait-turn with no prompt sent since launch fails at once", (t) => {
  const h = harness(t);
  h.launch();

  const result = h.cp("wait-turn", h.run, "5");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no prompt sent/);
  assert.ok(result.seconds < 1.5);
});

test("wait-turn keeps waiting past the previous turn's end and returns when the sent prompt's turn ends", async (t) => {
  const h = harness(t);
  h.launch();
  h.append("s.jsonl", header, system, user("first"), assistant("stop"));
  assert.equal(h.cp("send", h.run, "second").status, 0);

  const notRead = h.cp("wait-turn", h.run, "1");
  assert.equal(notRead.status, 1);
  assert.match(notRead.stderr, /no turn started since the last send/);

  const waiting = h.cpAsync("wait-turn", h.run, "10");
  h.append("s.jsonl", user("second"), assistant("toolUse"));
  await sleep(1200);
  h.append("s.jsonl", toolResult, assistant("stop"));
  const result = await waiting;

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.seconds >= 1.2, `returned after ${result.seconds}s, before the turn ended`);
});

test("wait-turn returns at once on a turn that ended before the wait started", (t) => {
  const h = harness(t);
  h.launch();
  h.append("s.jsonl", header, system, user("first"), assistant("stop"));
  h.cp("send", h.run, "second");
  h.append("s.jsonl", user("second"), assistant("stop"));

  const result = h.cp("wait-turn", h.run, "10");

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.seconds < 1.5);
});

test("wait-turn ignores the end of the turn a prompt was queued behind", (t) => {
  const h = harness(t);
  h.launch();
  h.append("s.jsonl", header, system, user("first"), assistant("toolUse"));
  h.cp("send", h.run, "queued");
  h.append("s.jsonl", toolResult, assistant("stop"));

  assert.equal(h.cp("wait-turn", h.run, "1").status, 1);

  h.append("s.jsonl", user("queued"), assistant("stop"));
  assert.equal(h.cp("wait-turn", h.run, "5").status, 0);
});

test("wait-turn counts an aborted or length-capped turn as ended and keeps waiting through an error", (t) => {
  const h = harness(t);
  h.launch();
  h.cp("send", h.run, "first");
  h.append("s.jsonl", header, system, user("first"), {
    type: "message",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "overloaded_error",
    },
  });

  const retrying = h.cp("wait-turn", h.run, "1");
  assert.equal(retrying.status, 1);
  assert.match(retrying.stderr, /overloaded_error/);

  h.append("s.jsonl", assistant("aborted"));
  assert.equal(h.cp("wait-turn", h.run, "5").status, 0);

  h.cp("send", h.run, "second");
  h.append("s.jsonl", user("second"), assistant("length"));
  assert.equal(h.cp("wait-turn", h.run, "5").status, 0);
});

test("wait-turn keeps waiting through a reply truncated inside a tool call until its continuation ends", async (t) => {
  const h = harness(t);
  h.launch();
  h.append("s.jsonl", header, system);
  h.cp("send", h.run, "run a command");
  h.append("s.jsonl", user("run a command"), truncatedToolCall, toolResult);

  const waiting = h.cpAsync("wait-turn", h.run, "10");
  await sleep(1200);
  h.append("s.jsonl", assistant("stop"));
  const result = await waiting;

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.seconds >= 1.2, `returned after ${result.seconds}s, before the continuation`);
});

test("a send during wait-turn leaves the wait on the prompt it started with", async (t) => {
  const h = harness(t);
  h.launch();
  h.append("s.jsonl", header, system);
  h.cp("send", h.run, "first");
  h.append("s.jsonl", user("first"), assistant("toolUse"));

  const waiting = h.cpAsync("wait-turn", h.run, "5");
  await sleep(500);
  h.cp("send", h.run, "second");
  h.append("s.jsonl", toolResult, assistant("stop"));
  const result = await waiting;

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.seconds < 2.5, `returned after ${result.seconds}s, not on the first turn's end`);
});

test("both waits read the most recently modified session file, not the first by name", (t) => {
  const h = harness(t);
  h.launch();
  h.cp("send", h.run, "first");
  h.append("a.jsonl", header, system, user("first"), assistant("toolUse"));
  h.append("b.jsonl", header, system, user("first"), assistant("stop"));
  h.append("c.jsonl", header, system, user("first"), assistant("toolUse"));
  h.touch("a.jsonl", 20);
  h.touch("c.jsonl", 10);

  const turn = h.cp("wait-turn", h.run, "5");
  assert.equal(turn.status, 0, turn.stderr);
  const idle = h.cp("wait-idle", h.run, "10");
  assert.equal(idle.status, 0, idle.stderr);
});

test("wait-turn reads the session file Pi creates after the first send", (t) => {
  const h = harness(t);
  h.launch();
  h.cp("send", h.run, "first");
  h.append("s.jsonl", header, system, user("first"), assistant("stop"));

  assert.equal(h.cp("wait-turn", h.run, "5").status, 0);
});

test("wait-idle returns only after the background job exits and the turn its result starts ends", async (t) => {
  const h = harness(t);
  h.launch();
  h.cp("send", h.run, "start a job");
  h.append(
    "s.jsonl",
    header,
    system,
    user("start a job"),
    assistant("toolUse"),
    toolResult,
    assistant("stop"),
  );

  const job = spawn("sleep", ["30"], {
    env: { ...process.env, VERIFY_PI_SETUP_RUN: h.run },
    stdio: "ignore",
  });

  t.after(() => job.kill());
  await sleep(200);

  assert.equal(
    h.cp("wait-turn", h.run, "5").status,
    0,
    "the turn-end wait returns while the job runs",
  );
  const busy = h.cp("wait-idle", h.run, "2");
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, new RegExp(`background process.*${job.pid} sleep`));
  assert.doesNotMatch(busy.stderr, /sleep 30/, "names the process without its arguments");

  job.kill();
  await sleep(200);
  h.append("s.jsonl", jobResult);
  const told = h.cp("wait-idle", h.run, "2");
  assert.equal(told.status, 1, "a turn started by the job's result is not idle");
  assert.match(told.stderr, /turn/);

  h.append("s.jsonl", assistant("stop"));
  const idle = h.cp("wait-idle", h.run, "10");
  assert.equal(idle.status, 0, idle.stderr);
  assert.ok(idle.seconds >= 2, `idle held for ${idle.seconds}s, less than the quiet period`);
});

test("wait-idle does not count Pi itself as a background job", (t) => {
  const h = harness(t);
  h.launch();
  h.pi();

  const result = h.cp("wait-idle", h.run, "10");

  assert.equal(result.status, 0, result.stderr);
});

test("wait-idle ignores a process of another run whose id starts with this one", async (t) => {
  const h = harness(t);
  h.launch();

  const other = spawn("sleep", ["30"], {
    env: { ...process.env, VERIFY_PI_SETUP_RUN: `${h.run}-other` },
    stdio: "ignore",
  });

  t.after(() => other.kill());
  await sleep(200);

  const result = h.cp("wait-idle", h.run, "10");

  assert.equal(result.status, 0, result.stderr);
});

test("wait-idle waits a full quiet period after the session file last changed", async (t) => {
  const h = harness(t);
  h.launch();
  h.append("s.jsonl", header, system, user("first"), assistant("stop"));

  const waiting = h.cpAsync("wait-idle", h.run, "10");
  await sleep(1500);
  h.append("s.jsonl", { type: "model_change", provider: "p", modelId: "m" });
  const result = await waiting;

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.seconds >= 3.5, `idle after ${result.seconds}s, under 2 s after the change`);
});

test("wait-idle keeps waiting while a sent prompt has no user message in the session", (t) => {
  const h = harness(t);
  h.launch();
  h.append("s.jsonl", header, system, user("first"), assistant("stop"));
  h.cp("send", h.run, "/fast");

  const result = h.cp("wait-idle", h.run, "2");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/fast/);
});

test("wait-idle on a fresh run with nothing sent returns", (t) => {
  const h = harness(t);
  h.launch();

  const result = h.cp("wait-idle", h.run, "10");

  assert.equal(result.status, 0, result.stderr);
});
