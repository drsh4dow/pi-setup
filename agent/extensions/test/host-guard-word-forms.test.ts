import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertEach,
  assertKillRefused,
  assertRuns,
  assertUnreadWordRefused,
  everySession,
  rootBash,
} from "./guard-fixtures.ts";

// The host guard reads as literal only the word forms it reproduces exactly: plain,
// single-quoted, double-quoted, and backslash-escaped text, and the ANSI-C escapes it
// decodes. A parameter, command, or arithmetic expansion stays runtime-unknown, so a
// shell fed by one still runs. Any other expansion leaves the word unread, and an
// unread word is refused where a shell or a guarded command reads it.

test("a locale-quoted script fed to a shell is refused", async () => {
  await assertEach(
    everySession([
      'echo $"pkill x" | bash',
      'printf "%s" $"pkill x" | bash',
      'bash <<< $"pkill x"',
      'echo p$"kill x" | bash',
      'echo $"rm -rf /tmp/aa-*" | sh',
    ]),
    (refusal, label) => assert.ok(refusal, `${label} is refused`),
  );
});

test("a locale-quoted word is refused unread where a shell or a guarded command reads it", async () => {
  await assertEach(
    everySession([
      'echo $"true" | bash',
      'printf "%s" $"true" | sh',
      'bash <<< $"true"',
      'bash -c $"true"',
      'eval $"true"',
      '$"true" x',
      'env $"true" x',
      'kill $"1"',
      'rm -rf $"dist"',
      'xargs $"true"',
    ]),
    assertUnreadWordRefused(/locale-quoted/),
  );
});

test("a brace expansion is refused where a shell or a guarded command reads it", async () => {
  await assertEach(
    everySession([
      "echo {pkill,x} | bash",
      "printf '%s ' {pkill,x} | bash",
      "{pkill,x}",
      "bash -c {pkill,x}",
      "pk{ill,} x",
      "rm -rf {dist,build}",
      "bash <<< {true,x}",
      "kill {1..3}",
      "bash <<< {pkill,x}",
    ]),
    assertUnreadWordRefused(/brace expansion/),
  );
});

test("a $[…] arithmetic word is refused where a shell or a guarded command reads it", async () => {
  await assertEach(
    everySession([
      "echo $[1] | bash",
      "bash -c $[1]",
      "$[1] x",
      'echo "$[1]" | sh',
      "kill $[1]",
      'kill "$[1]"',
    ]),
    assertUnreadWordRefused(/\$\[…\]/),
  );
});

test("an unquoted pattern in a command name or a shell's script is refused", async () => {
  await assertEach(
    everySession([
      "/usr/bin/pk*ll x",
      "echo /usr/bin/pkil? x | bash",
      "/usr/bin/pkil[l] x",
      "sudo /usr/bin/pk* x",
      "bash -c /usr/bin/pk*",
    ]),
    assertUnreadWordRefused(/pattern/),
  );
});

test("a literal script in a brace or pattern that no shell expands is still read", async () => {
  await assertEach(
    everySession([
      'echo "{pkill,x}"; pkill x',
      "bash <<< 'pkill x'",
      "/usr/*/pkill x",
      "echo ${x:-a ; b}; pkill x",
    ]),
    assertKillRefused,
  );
});

test("a locale string, a brace expansion, or a pattern that no shell reads still runs", async () => {
  await assertEach(
    rootBash([
      'echo $"hello world"',
      'echo $"pkill x" > out.txt',
      'git commit -m $"fix: subject"',
      "echo {a,b}",
      "echo {1..3} > out.txt",
      "mkdir -p src/{lib,test}",
      "cp file.{ts,bak}",
      "cat <<< {a,b}",
      'echo "$[1]"',
      "rm -f *.log",
      "rm -rf dist/*",
      "ls *.ts",
      "[ -f x ] && echo ok",
      "find . -name '*.ts' -exec rm {} +",
      "awk '{print $1,$2}' file",
      "echo ${x,}",
      "~/.cache/tool/venv-*/bin/python -m pyflakes src/*.py",
      "./node-v20*/bin/node -v",
      "node --test test/{a,b}.test.ts",
      "bash scripts/*.sh",
      'to=${m#* }; echo "$to"',
      'rest=${line%% *}; echo "$rest"',
      "files=*.ts; echo $files",
      "X={a,b} make build",
    ]),
    assertRuns,
  );
});

test("a shell fed by a parameter, command, or arithmetic expansion still runs", async () => {
  await assertEach(
    rootBash([
      'echo "$x" | bash',
      'bash -c "$cmd"',
      "echo $(cat script.sh) | bash",
      "echo $((1 + 2)) | bash",
      "echo ~ | bash",
      'bash <<< "$script"',
    ]),
    assertRuns,
  );
});
