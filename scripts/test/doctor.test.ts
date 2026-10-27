import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";

import { TIER_NAMES, activationFix, judgePiLoad } from "../doctor/doctor.ts";
import { parsePiOutput, parseShellEnv, resolveCommand } from "../doctor/probe.ts";

const repo = realpathSync(new URL("../..", import.meta.url).pathname);

function scratch(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "doctor-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  return root;
}

function executable(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

test("every folder under mise/ is a tier the doctor checks, and every tier has a folder", () => {
  const folders = readdirSync(join(repo, "mise")).toSorted();
  assert.deepEqual(folders, [...TIER_NAMES].toSorted());
});

test("a new shell's environment is read after the marker, past profile noise", () => {
  const output =
    "welcome banner\nPATH=/not/this\n__m__\nPATH=/a:/b\nMULTI=line one\nline two\nEMPTY=\n";

  const env = parseShellEnv(output, "__m__");
  assert.equal(env?.get("PATH"), "/a:/b");
  assert.equal(env?.get("MULTI"), "line one");
  assert.equal(env?.get("EMPTY"), "");
  assert.equal(parseShellEnv("no marker here\n", "__m__"), undefined);
});

test("a command resolves to the first executable file on PATH", (t) => {
  const root = scratch(t);
  const [first, second, third] = ["first", "second", "third"].map((name) => join(root, name));

  for (const directory of [first, second, third]) mkdirSync(directory);
  writeFileSync(join(first, "tool"), "not executable");
  mkdirSync(join(second, "tool"));
  executable(join(third, "tool"), "true");

  assert.equal(resolveCommand("tool", [first, second, third].join(delimiter)), join(third, "tool"));
  assert.equal(resolveCommand("tool", first), undefined);
});

function listing(paths: string[]) {
  return JSON.stringify({
    type: "response",
    command: "get_commands",
    success: true,
    data: {
      commands: paths.map((path) => ({ name: "x", source: "skill", sourceInfo: { path } })),
    },
  });
}

test("Pi passes only when it loads every skill of this checkout without errors", () => {
  const skillsDir = join(repo, "agent", "skills");

  const ours = [join(skillsDir, "how", "SKILL.md"), join(skillsDir, "why", "SKILL.md")];

  const clean = judgePiLoad({ load: parsePiOutput(listing(ours)), skillsDir, expectedSkills: 2 });
  assert.equal(clean.status, "ok");

  const broken = `Error: Failed to load extension "/x/index.ts": Cannot find package 'effect'\n${listing(ours)}`;
  const failed = judgePiLoad({ load: parsePiOutput(broken), skillsDir, expectedSkills: 2 });
  assert.equal(failed.status, "fail");
  assert.match(failed.detail, /Cannot find package 'effect'/);

  const elsewhere = ["/home/other/.pi/agent/skills/how/SKILL.md"];

  const wrongCheckout = judgePiLoad({
    load: parsePiOutput(listing(elsewhere)),
    skillsDir,
    expectedSkills: 2,
  });

  assert.equal(wrongCheckout.status, "fail");
  assert.match(wrongCheckout.detail, /clone this repository to ~\/\.pi/);

  const silent = judgePiLoad({ load: parsePiOutput(""), skillsDir, expectedSkills: 2 });
  assert.equal(silent.status, "fail");
});

test("the bash activation fix makes a new login shell activate mise", (t) => {
  const home = scratch(t);
  const mise = join(home, "mise");
  executable(mise, 'echo "export PI_SETUP_ACTIVATED=$2"');
  // Debian's default ~/.profile sources ~/.bashrc; a bare HOME needs the same link.
  writeFileSync(join(home, ".profile"), '. "$HOME/.bashrc"\n');

  const fix = activationFix({ shell: "/bin/bash", mise, platform: "linux" });
  const env = { HOME: home, PATH: process.env.PATH };
  assert.ok(fix);
  assert.equal(spawnSync("bash", ["-c", fix], { env }).status, 0);

  const shell = spawnSync("bash", ["-l", "-i", "-c", "echo $PI_SETUP_ACTIVATED"], {
    env,
    encoding: "utf8",
  });

  assert.equal(shell.stdout.trim(), "bash");
});
