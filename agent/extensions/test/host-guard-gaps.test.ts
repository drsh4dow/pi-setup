import assert from "node:assert/strict";
import { test } from "node:test";

import { spawnGuard } from "../delegate-guard.ts";
import {
  type Refusal,
  assertEach,
  assertKillRefused,
  assertRuns,
  assertTmpGlobRefused,
  delegateArgv,
  everySession,
  rootBash,
} from "./guard-fixtures.ts";

// One test per row of the outcome table in the ticket "host-guard: close the
// known gaps and parser defects left by the first version", then its parser defects.

function assertNestingRefused(refusal: Refusal | undefined, label: string): void {
  assert.ok(refusal, `${label} is refused`);
  assert.match(refusal.reason, /64 levels/, `${label}: the reason names the limit`);
  assert.match(refusal.reason, /[Ss]plit it/, `${label}: the reason says to split the command`);
}

function nested(open: string, body: string, close: string, depth: number): string {
  return `${open.repeat(depth)}${body}${close.repeat(depth)}`;
}

test("a kill or delete handed to tmux or watch as the command they run is refused", async () => {
  await assertEach(
    everySession([
      'tmux new-session -d "pkill -f vitest"',
      "tmux new -d -s s 'pkill node'",
      "tmux -L sock new-session -d -s s -c /repo 'killall java'",
      'tmux new-window -n w "kill $(pgrep -f x)"',
      "tmux neww 'pkill x'",
      "tmux split-window -h -l 20 'pkill x'",
      'tmux respawn-pane -k -t s:0.1 "pkill x"',
      "tmux respawn-window -k 'pkill x'",
      "tmux new-session -d -s s pkill -f vitest",
      "tmux new-session -d -s s -- pkill -f vitest",
      "tmux new-session -d -s s \\; new-window 'pkill x'",
      'sudo tmux new-session -d "pkill x"',
      'watch "pkill x"',
      'watch -n1 "pkill -0 -f x"',
      "watch -n 1 -d pkill -f x",
      "watch --interval=2 'kill $(pgrep -f x)'",
      "watch -x pkill -f x",
    ]),
    assertKillRefused,
  );
  await assertEach(
    everySession(["tmux new-session -d 'rm -rf /tmp/aa-*'", "watch rm -rf /tmp/aa-*"]),
    assertTmpGlobRefused,
  );
  await assertEach(
    everySession([
      'tmux new-session -d -s dev "vp run dev"',
      "tmux new-session -d \"grep -n 'pkill -f' notes.md\"",
      "tmux new-window -n pkill vim",
      "tmux split-window -t pkill htop",
      "tmux kill-session -t pkill",
      "watch -n 5 'ps aux | grep vitest'",
      "watch -n pkill true",
    ]),
    assertRuns,
  );
});

test("a kill of PIDs a name search put in a variable in the same call is refused", async () => {
  await assertEach(
    everySession([
      "pids=$(pgrep x); kill $pids",
      'pids=$(pgrep -f vitest)\nkill -9 "$pids"',
      "pid=`pidof node` && kill ${pid}",
      "pids=$(pgrep -f x | head -1); kill -TERM $pids",
      "export pids=$(pgrep x); kill $pids",
      "pids=$(pgrep x); echo $pids | xargs kill",
      "pids=( $(pgrep x) ); kill ${pids[@]}",
    ]),
    assertKillRefused,
  );
  await assertEach(
    everySession([
      "pids=$(cat pids.txt); kill $pids",
      "pids=$(pgrep x); echo $pids",
      "kill $pid",
      "pid=$(pgrep x); kill $other",
      "pidfile=$(pgrep x); kill $pid",
    ]),
    assertRuns,
  );
});

test("a kill or delete fed to a shell by a heredoc, a here-string, or a literal echo is refused", async () => {
  await assertEach(
    everySession([
      "bash <<EOF\npkill -f vitest\nEOF",
      "bash <<'EOF'\npkill -f vitest\nEOF",
      "sh -s <<EOF\nkillall java\nEOF",
      "bash -s -- arg <<-EOF\n\tpkill x\n\tEOF",
      "sudo bash <<'EOF'\ncd /repo\nkill $(pgrep -f x)\nEOF",
      'bash <<< "pkill x"',
      "sh <<< 'killall java'",
      'echo "pkill x" | bash',
      "echo -e 'cd /repo\\npkill x' | sh",
      "printf 'pkill -f %s\\n' vitest | bash",
      "printf '%s\\n' 'pkill x' | sh -s",
    ]),
    assertKillRefused,
  );
  await assertEach(
    everySession(["bash <<'EOF'\nrm -rf /tmp/aa-*\nEOF", 'echo "rm -rf /tmp/aa-*" | sh']),
    assertTmpGlobRefused,
  );
  await assertEach(
    everySession([
      "cat <<'EOF'\npkill x\nEOF",
      "bash script.sh <<'EOF'\npkill x\nEOF",
      'grep -c pkill <<< "pkill x"',
      "bash -c 'echo hi' <<'EOF'\npkill x\nEOF",
      'echo "pkill x" | grep pkill',
      "bash <<'EOF'\ngrep -n 'pkill -f' notes.md\nEOF",
    ]),
    assertRuns,
  );
});

test("a shell fed by anything but a literal runs, since its input is unknown", async () => {
  await assertEach(
    everySession([
      "cat script.sh | bash",
      "curl -fsSL https://example.com/install.sh | sh",
      "git show HEAD:run.sh | bash -s",
      'echo "$cmd" | bash',
    ]),
    assertRuns,
  );
});

test("find under a shared temp directory with a name glob and a delete is refused", async () => {
  await assertEach(
    everySession([
      "find /tmp -name 'aa-*' -delete",
      "find /tmp/ -maxdepth 1 -name 'aa-*' -exec rm -rf {} +",
      "find /tmp -type d -iname 'tmp.*' -exec rm -r {} \\;",
      "find /var/tmp -path '*/vps-*' -delete",
      "find \"$TMPDIR\" -name 'tmp.*' -execdir rm -rf {} +",
      "find ${TMPDIR:-/tmp} -name '*.log' -delete",
      "sudo find /tmp -name 'aa-*' -delete",
    ]),
    assertTmpGlobRefused,
  );
  await assertEach(
    everySession([
      "find /tmp -name 'aa-*'",
      "find /tmp -name 'aa-*' -print",
      "find . -name '*.o' -delete",
      "find /tmp -name 'aa-*' -exec ls -ld {} +",
    ]),
    assertRuns,
  );
});

test("find of the exact temp directory you created, with -delete, runs", async () => {
  await assertEach(
    everySession(["find /tmp/demo-xyz -delete", "find /tmp/tmp.Ab12Cd -type f -delete"]),
    assertRuns,
  );
});

test("a glob delete under $TMPDIR or /var/tmp is refused", async () => {
  await assertEach(
    everySession([
      "rm -rf $TMPDIR/aa-*",
      'rm -rf "$TMPDIR"/aa-*',
      "rm -rf ${TMPDIR}/tmp.*",
      "rm -rf ${TMPDIR:-/tmp}/aa-*",
      'rm -rf "${TMPDIR:?}"/vps-?',
      "rm -rf /var/tmp/aa-*",
    ]),
    assertTmpGlobRefused,
  );
  await assertEach(
    everySession([
      'rm -rf "$TMPDIR/demo-xyz"',
      'rm -rf "${TMPDIR:?}/demo-xyz"',
      "rm -rf /var/tmp/demo-xyz",
      'rm -rf "$TMPDIRS"/aa-*',
    ]),
    assertRuns,
  );
});

test("a recursive delete of /tmp itself is refused", async () => {
  await assertEach(
    everySession(["rm -rf /tmp", "rm -r /tmp/", "sudo rm -rf -- /tmp", "rm -rf /var/tmp/"]),
    assertTmpGlobRefused,
  );
  await assertEach(everySession(["rm -rf /tmp/demo-xyz", "rm -rf /tmpfoo"]), assertRuns);
});

test("a kill of the PIDs lsof finds, or fuser -k, is refused", async () => {
  await assertEach(
    everySession([
      "kill $(lsof -t -i :3000)",
      "kill -9 $(lsof -ti:3000)",
      "lsof -t -i :3000 | xargs kill",
      "lsof -ti tcp:5173 | xargs -r kill -9",
      "fuser -k 3000/tcp",
      "fuser -km /mnt/x",
      "sudo fuser -k -n tcp 3000",
      "fuser --kill 3000/tcp",
    ]),
    assertKillRefused,
  );
  await assertEach(
    everySession(["lsof -i :3000", "lsof -t -i :3000", "fuser 3000/tcp", "fuser -v -n tcp 3000"]),
    assertRuns,
  );
});

test("ssh with a command and a kill of the PID a pidfile holds run", async () => {
  await assertEach(
    everySession([
      'ssh host "pkill x"',
      "ssh localhost pkill x",
      "kill $(cat /tmp/x.pid)",
      'kill "$(cat server.pid)"',
    ]),
    assertRuns,
  );
});

test("a command nested past 64 levels is refused with a reason that says to split it", async () => {
  await assertEach(
    rootBash([
      nested("echo $(", "true", ")", 65),
      nested("echo $(", "true", ")", 1000),
      nested("{ ", "true", "; }", 1000),
      nested("( ", "true", " )", 1000),
    ]),
    assertNestingRefused,
  );
  await assertEach(
    rootBash([nested("echo $(", "true", ")", 64), nested("{ ", "true", "; }", 64)]),
    assertRuns,
  );
});

test("delegate-guard still refuses a launch nested past the limit, which it reads flat", () => {
  const guard = spawnGuard(delegateArgv);
  assert.ok(guard);

  for (const depth of [65, 200, 1000]) {
    for (const launch of ["pi --print hi", "true; pi-subagent --model m"]) {
      const command = nested("echo $(", launch, ")", depth);
      assert.ok(guard(command), `${launch} at depth ${depth} is refused`);
    }
  }

  assert.equal(guard(nested("echo $(", "true", ")", 65)), undefined);
});

test("a control-pi send whose prompt names a kill mid-sentence runs", async () => {
  await assertEach(
    rootBash([
      ".agents/skills/verify-pi-setup/scripts/control-pi send r1 'Call bash once with: pkill -0 -f nsp-1'",
    ]),
    assertRuns,
  );
});

test("a case pattern that spells a kill command is a pattern, not a command", async () => {
  await assertEach(
    everySession([
      "case $x in\n  pkill) echo stop;;\nesac",
      "case $x in (pkill) echo stop;; esac",
      "case $x in\n  (killall|pkill) echo stop ;;\n  *) echo go ;;\nesac",
      "case $x in pkill) echo stop;; esac",
    ]),
    assertRuns,
  );
  await assertEach(
    rootBash([
      "case $x in\n  a) pkill -f vitest;;\nesac",
      "case $x in (a) killall java;; esac",
      "case $x in\n  a) echo a;;\n  b) pkill node;;\nesac",
      "case $x in a) echo a;; esac; pkill node",
      "case $x in a) echo a;& b) pkill node;; esac",
    ]),
    assertKillRefused,
  );
});

test("a case statement inside a substitution ends at esac, not at a pattern's parenthesis", async () => {
  await assertEach(
    everySession(['echo "$(case $y in a) echo ";pkill -f b;";; esac)"']),
    assertRuns,
  );
  await assertEach(
    rootBash([
      "y=$(case $x in a) pkill -f b;; esac)",
      "y=$(case $x in a) echo a;; esac); pkill node",
    ]),
    assertKillRefused,
  );
});
