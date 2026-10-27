import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { pipelines } from "../../lib/shell-command.ts";
import { hostGuard } from "../host-guard.ts";
import {
  assertAnsiCRefused,
  assertEach,
  assertKillRefused,
  assertRuns,
  assertTmpGlobRefused,
  everySession,
  rootBash,
} from "./guard-fixtures.ts";

// ANSI-C quoting, `$'…'`: the host guard reads the word as bash decodes it, or refuses
// it unread where it reaches a shell, a command name, or a guarded command's operands.

test("an ANSI-C quoted script fed to a shell is read as bash decodes it", async () => {
  await assertEach(
    everySession([
      String.raw`echo $'true\npkill x' | bash`,
      String.raw`printf '%s' $'true\npkill x' | bash`,
      String.raw`bash <<< $'true\npkill x'`,
      String.raw`printf '%s' $'\n' 'pkill x' | bash`,
      String.raw`echo $'\x70kill x' | bash`,
      String.raw`printf '%s' $'\x70kill x' | bash`,
      String.raw`bash -c $'\160kill x'`,
      String.raw`$'\x70kill' x`,
      String.raw`bash <<< $'true;\tpkill\x20x'`,
    ]),
    assertKillRefused,
  );

  await assertEach(
    everySession([
      String.raw`printf '%s' $'rm -rf /tmp/aa-\x2a' | sh`,
      String.raw`rm -rf $'/tmp/aa-\52'`,
    ]),
    assertTmpGlobRefused,
  );
});

test("an ANSI-C quoted word the guard cannot decode is refused where a shell or a guarded command reads it", async () => {
  await assertEach(
    everySession([
      String.raw`echo $'\u0070kill x' | bash`,
      String.raw`bash <<< $'\U00000070kill x'`,
      String.raw`bash -c $'\cJpkill x'`,
      String.raw`eval $'\u0070kill x'`,
      String.raw`watch -n 1 $'\u0070kill x'`,
      String.raw`$'\u0070kill' x`,
      String.raw`kill $'\u0031'`,
      String.raw`rm -rf $'/tmp/\u002a'`,
      String.raw`printf '%s' $'a\0b' | sh`,
      String.raw`echo $'\xe9' | bash`,
    ]),
    assertAnsiCRefused,
  );
});

test("an ANSI-C quoted word that no shell reads still runs", async () => {
  await assertEach(
    rootBash([
      String.raw`echo $'a\tb'`,
      String.raw`echo $'a\tb' > out.txt`,
      String.raw`printf '%s\n' $'col1\tcol2' >> table.tsv`,
      String.raw`git commit -m $'fix: subject\n\nBody line.'`,
      String.raw`echo $'\u2713 done'`,
      String.raw`grep -P $'\t' file.tsv`,
      String.raw`echo $'pkill x'`,
    ]),
    assertRuns,
  );
});

// What bash prints for each word, run alone with no shell reading the output.
function bashDecodes(word: string): string {
  const printed = spawnSync("bash", ["--norc", "--noprofile", "-c", `printf '%s' ${word}`], {
    env: { PATH: process.env["PATH"] ?? "" },
  });

  return printed.stdout.toString("latin1");
}

const DECODED_WORDS = [
  String.raw`$'true\npkill x'`,
  String.raw`$'\a\b\e\E\f\n\r\t\v'`,
  String.raw`$'\\ \' \" \?'`,
  String.raw`$'\x70kill\x20x'`,
  String.raw`$'\x7g\x41g\x414'`,
  String.raw`$'\160\1601\52\7'`,
  String.raw`$'\x'`,
  String.raw`$'\xg \8 \9 \q \N \%'`,
  String.raw`$'a\'b'`,
  String.raw`$'rm -rf /tmp/aa-\x2a'`,
  String.raw`$'tab\there'`,
  String.raw`pre$'\x41'post`,
  String.raw`$'\x2'`,
  String.raw`$'\177'`,
];

test("the guard reads each ANSI-C quoted word as bash decodes it", () => {
  for (const word of DECODED_WORDS) {
    const reason = hostGuard(`printf '%s' ${word} | bash`) ?? "";
    assert.doesNotMatch(reason, /ANSI-C/, `${word} is read`);

    const [read] = pipelines(`printf '%s' ${word}`)[0]?.[0]?.argv.slice(2) ?? [];

    assert.equal(read, bashDecodes(word), word);
  }
});
