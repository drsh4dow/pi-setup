import assert from "node:assert/strict";
import { test } from "node:test";

import { spawnGuard } from "../delegate-guard.ts";
import {
  ECHO_FORMS,
  PRINTF_FORMS,
  assertEach,
  assertEchoRefused,
  assertKillRefused,
  assertNestingRefused,
  assertPrintfRefused,
  assertReadAsPrinted,
  assertRuns,
  assertTmpGlobRefused,
  delegateArgv,
  everySession,
  nested,
  rootBash,
} from "./guard-fixtures.ts";

// One test per row of the outcome table in the ticket "host-guard: close the
// known gaps and parser defects left by the first version", then its parser defects.

// A shell fed its script by a heredoc, `depth` heredocs deep, around `true`.
function heredocs(depth: number): string {
  const opens = Array.from({ length: depth }, (_, level) => `bash <<'E${level}'\n`).join("");
  const closes = Array.from({ length: depth }, (_, level) => `E${depth - 1 - level}\n`).join("");

  return `${opens}true\n${closes}`;
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

test("find under a temp directory with a name glob and a delete is refused", async () => {
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
    for (const launch of [
      "pi --print hi",
      "true; pi-subagent --model m",
      "'pi-subagent' --model m",
      "'pi' --print hi",
      "p\\i --print hi",
      "p\\\ni --print hi",
      "p\\\r\ni --print hi",
      '"pi"-subagent --model m',
    ]) {
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

test("a program outside the runner list keeps an argument that starts with a kill as text", async () => {
  await assertEach(
    everySession([
      'git commit -m "pkill x"',
      '.agents/skills/verify-pi-setup/scripts/control-pi send r1 "pkill x"',
      "gh pr comment 1 --body 'rm -rf /tmp/aa-*'",
    ]),
    assertRuns,
  );
});

test("a shell nested past 64 levels through heredocs is refused, and at 64 levels runs", async () => {
  await assertEach(rootBash([heredocs(65)]), assertNestingRefused);
  await assertEach(rootBash([heredocs(64)]), assertRuns);
});

test("an unquoted heredoc fed to a shell runs its substitutions before the shell reads it", async () => {
  await assertEach(
    everySession([
      "bash <<EOF\necho '$(pkill x)'\nEOF",
      "bash <<EOF\n# $(pkill x)\nEOF",
      "sh -s <<EOF\necho '`killall java`'\nEOF",
    ]),
    assertKillRefused,
  );
  await assertEach(everySession(["bash <<'EOF'\necho '$(pkill x)'\nEOF"]), assertRuns);
});

test("a literal printf piped to a shell is read as the text printf prints", async () => {
  await assertEach(
    everySession([
      "printf '%s' 'pkill x' | bash",
      "printf '%s\\n' true 'pkill x' | bash",
      "printf '%b' 'true\\npkill x' | sh",
      "printf -- '%s %s' pkill x | bash",
      "printf '100%% done\\n%s\\n' 'pkill x' | bash",
    ]),
    assertKillRefused,
  );
  await assertEach(everySession(["printf '%s' 'rm -rf /tmp/aa-*' | sh"]), assertTmpGlobRefused);
  await assertEach(
    everySession([
      "printf 'echo %s\\n' 'pkill x' | bash",
      "printf '%s\\n' 'echo pkill' | bash",
      "printf -v cmd '%s' 'pkill x' | bash",
    ]),
    assertRuns,
  );
});

test("a shell given - as its script reads stdin", async () => {
  await assertEach(
    everySession([
      "echo pkill x | bash -",
      "bash - <<'EOF'\npkill x\nEOF",
      "sh -s - <<< 'killall java'",
    ]),
    assertKillRefused,
  );
  await assertEach(everySession(["bash - script.sh <<'EOF'\npkill x\nEOF"]), assertRuns);
});

test("fuser with k in a group of short options is refused", async () => {
  await assertEach(
    everySession([
      "fuser -4k 3000/tcp",
      "fuser -6k 3000/tcp",
      "fuser -Ik /mnt/x",
      "fuser -Mkm /mnt",
    ]),
    assertKillRefused,
  );
  await assertEach(everySession(["fuser -4 3000/tcp", "fuser -Iv /mnt/x"]), assertRuns);
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

test("the host guard reads a printf of %s, %b, %%, and its escapes as real printf prints it", () => {
  assertReadAsPrinted("printf", PRINTF_FORMS);
});

test("a printf piped to a shell whose format the guard cannot read is refused, and alone runs", async () => {
  await assertEach(
    everySession([
      "printf '%-6s%s\\n' pkill x | bash",
      "printf '%s%1s%s' pkill '' x | bash",
      "printf '%-8s %s\\n' pkill x | bash",
    ]),
    (refusal, label) => assert.ok(refusal, `${label} is refused`),
  );
  await assertEach(
    everySession([
      "printf '%5s\\n' true | bash",
      "printf '%.3s\\n' trueish | bash",
      "printf '%-s\\n' true | bash",
      "printf '%0s\\n' true | bash",
      "printf '%*s\\n' 3 true | bash",
      "printf '%c\\n' true | bash",
      "printf '%d\\n' 3 | bash",
      "printf '%q\\n' true | bash",
      "printf '%ls\\n' true | sh",
      "printf 'true%' | bash",
      "printf 'echo hi\\c; echo x' | bash",
      "printf 'echo \\'\\''hi' | bash",
      "printf '\\u0070kill x' | bash",
      "printf 'true\\?\\E' | bash",
      "printf '\\%s' true | bash",
      "printf '\\x' | bash",
      "printf 'pk\\0ill x' | bash",
      "printf '%b' 'echo \\\"; true' | bash",
    ]),
    assertPrintfRefused,
  );
  await assertEach(
    everySession([
      "printf '%5d\\n' 3",
      "printf '%-8s|%s\\n' name value",
      "printf '%5s\\n' x | grep x",
      "printf '%c' x > out.txt",
      "printf -v cmd '%5s' 'pkill x' | bash",
    ]),
    assertRuns,
  );
});

test("a printf escape or %b argument that spells a kill or a temp glob delete is refused", async () => {
  await assertEach(
    everySession([
      "printf '%b' '\\x70kill x' | bash",
      "printf '\\160kill x' | bash",
      "printf '%b' '\\0160kill x' | sh",
      "printf 'true\\x0apkill x' | bash",
    ]),
    assertKillRefused,
  );
  await assertEach(everySession(["printf '%b' 'rm -rf /tmp/aa-\\x2a' | sh"]), assertTmpGlobRefused);
  await assertEach(everySession(["printf '%b%s' 'echo hi\\c' '; pkill x' | bash"]), assertRuns);
});

test("find's -- and the options before it do not hide a temp start path", async () => {
  await assertEach(
    everySession([
      "find -- /tmp -name 'aa-*' -delete",
      "find -H -- /tmp -name 'aa-*' -delete",
      "find -L -- /var/tmp -name 'aa-*' -delete",
      "find -O2 -- \"$TMPDIR\" -name 'aa-*' -delete",
      "find -P -- ${TMPDIR:-/tmp} -name 'aa-*' -exec rm -rf {} +",
      "find -D tree /tmp -name 'aa-*' -delete",
    ]),
    assertTmpGlobRefused,
  );
  await assertEach(
    everySession([
      "find /tmp/mydir-123 -delete",
      "find -- /tmp/exact-dir -delete",
      "find -- . -name '*.o' -delete",
    ]),
    assertRuns,
  );
});

test("delegate-guard reads a launch past the limit across line continuations and reserved words", () => {
  const guard = spawnGuard(delegateArgv);
  assert.ok(guard);

  for (const launch of [
    "p\\\ni --print hi",
    "pi-sub\\\nagent --model m",
    "pi --pr\\\nint hi",
    "if true; then pi-subagent --model m; fi",
    "if false; then true; elif pi-subagent --model m; then true; fi",
    "if false; then true; else pi-subagent --model m; fi",
    "while true; do pi --print hi; done",
    "until pi-subagent --model m; do true; done",
    "! pi-subagent --model m",
    "{ pi-subagent --model m; }",
    "true; ( pi --print hi )",
  ]) {
    assert.ok(guard(nested("echo $(", launch, ")", 65)), `${JSON.stringify(launch)} is refused`);
  }

  for (const harmless of ["if true; then echo pi; fi", "e\\\ncho pi-subagent"]) {
    assert.equal(guard(nested("echo $(", harmless, ")", 65)), undefined, `${harmless} runs`);
  }
});

test("a delete whose fallback is /tmp or /var/tmp itself is refused, and $TMPDIR itself runs", async () => {
  await assertEach(
    everySession([
      "rm -rf ${TMPDIR:-/tmp}",
      'rm -rf "${TMPDIR:-/tmp}"',
      "rm -rf ${TMPDIR:=/tmp}",
      "rm -rf ${TMPDIR-/var/tmp}/",
      "rm -rf ${SCRATCH:-/tmp}/aa-*",
    ]),
    assertTmpGlobRefused,
  );
  await assertEach(
    everySession([
      "rm -rf $TMPDIR",
      'rm -rf "$TMPDIR"',
      "rm -rf ${TMPDIR}",
      "rm -rf ${TMPDIR:-/tmp}/demo-xyz",
      "rm -rf ${SCRATCH:-/home/u/scratch}",
    ]),
    assertRuns,
  );
});

test("find of /tmp or /var/tmp itself with a delete is refused, and of a narrower start path runs", async () => {
  await assertEach(
    everySession([
      "find /tmp -delete",
      "find /var/tmp -delete",
      "find ${TMPDIR:-/tmp} -delete",
      "find /tmp/ -mindepth 1 -type f -delete",
      "find /tmp -type d -exec rm -rf {} +",
    ]),
    assertTmpGlobRefused,
  );
  await assertEach(
    everySession([
      "find /tmp/demo-xyz -delete",
      'find "$TMPDIR" -delete',
      "find /tmp -type f",
      "find /tmp -name 'aa-*' -print",
    ]),
    assertRuns,
  );
});

test("the host guard reads an echo and its escapes as real echo prints it", () => {
  assertReadAsPrinted("echo", ECHO_FORMS);
});

test("an echo escape that spells a kill is refused, and one the guard cannot read is refused when it feeds a shell", async () => {
  await assertEach(
    everySession([
      "echo -e '\\x70kill x' | bash",
      "echo -e '\\0160kill x' | sh",
      "echo -ne 'true\\x0apkill x' | bash",
    ]),
    assertKillRefused,
  );
  await assertEach(everySession(["echo -e 'rm -rf /tmp/aa-\\x2a' | sh"]), assertTmpGlobRefused);
  await assertEach(
    everySession([
      "echo -e '\\160kill x' | bash",
      "echo -e '\\u0070kill x' | bash",
      "echo -e 'true\\E' | bash",
      "echo 'true\\npkill x' | bash",
      "echo -E 'true\\x0apkill x' | bash",
      "echo -eE 'true\\x0apkill x' | bash",
      "echo --help | bash",
    ]),
    assertEchoRefused,
  );
  await assertEach(
    everySession([
      "echo 'pkill' > notes.txt",
      "echo -e 'a\\tb'",
      "echo -e '\\x70kill x'",
      "echo -e '\\160kill x' | grep kill",
      "echo 'echo pkill' | bash",
      "echo -e 'true\\c; pkill x' | bash",
    ]),
    assertRuns,
  );
});
