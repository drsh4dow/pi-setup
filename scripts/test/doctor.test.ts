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
import {
  newShellArgs,
  parseDeclaredPackages,
  parsePackageStatus,
  parsePiOutput,
  parseShellEnv,
  resolveCommand,
} from "../doctor/probe.ts";

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

test("a tier's system packages are the keys of its [bootstrap.packages] table alone", () => {
  const toml = [
    "[tools]",
    '"github:tlaplus/tlaplus[asset_pattern=tla2tools.jar]" = "1.7.4"',
    "",
    "[bootstrap.packages]",
    '"apt:libatomic1" = "latest"',
    '"dnf:libatomic" = { os = "linux" }',
    "",
    "[env]",
    '"apt:not-a-package" = "1"',
  ].join("\n");

  assert.deepEqual(parseDeclaredPackages(toml), ["apt:libatomic1", "dnf:libatomic"]);
});

test("package status keeps the packages of managers this machine has", () => {
  const states = parsePackageStatus(
    JSON.stringify({
      apt: {
        available: true,
        packages: [
          { package: "libatomic1", state: "missing" },
          { package: "pkg-config", state: "installed" },
        ],
      },
      pacman: {
        available: false,
        reason: "pacman not found",
        packages: [{ package: "gcc-libs", state: "skipped" }],
      },
    }),
  );

  assert.deepEqual(
    [...(states ?? [])],
    [
      ["apt:libatomic1", "missing"],
      ["apt:pkg-config", "installed"],
    ],
  );
  assert.equal(parsePackageStatus("mise nothing configured"), undefined);
});

// Each case is a home whose startup files end without a newline, as GitHub's macOS runner's
// ~/.bash_profile does. The fix must reach the shell a new terminal starts on that platform.
const startupCases: { platform: NodeJS.Platform; name: string; files: Record<string, string> }[] = [
  {
    platform: "linux",
    name: "a ~/.bash_profile that does not read ~/.bashrc",
    files: { ".bash_profile": 'export NVM_DIR="$HOME/.nvm"', ".bashrc": "export EDITOR=vi" },
  },
  {
    platform: "darwin",
    name: "a ~/.bash_profile",
    files: { ".bash_profile": "export EDITOR=vi", ".bashrc": "export EDITOR=nano" },
  },
  { platform: "darwin", name: "only a ~/.profile", files: { ".profile": "export EDITOR=vi" } },
];

for (const { platform, name, files } of startupCases)
  test(`the bash activation fix on ${platform} reaches a new terminal's shell, with ${name}`, (t) => {
    const home = scratch(t);
    const mise = join(home, "mise");
    executable(mise, 'echo "export PI_SETUP_ACTIVATED=$2"');

    for (const [file, content] of Object.entries(files)) writeFileSync(join(home, file), content);

    const fix = activationFix({ shell: "/bin/bash", mise, platform, home });
    const env = { HOME: home, PATH: process.env.PATH };
    assert.ok(fix);
    assert.equal(spawnSync("bash", ["-c", fix], { env }).status, 0);

    const shell = spawnSync(
      "bash",
      [...newShellArgs(platform), "-c", 'echo "$PI_SETUP_ACTIVATED $EDITOR"'],
      { env, encoding: "utf8" },
    );

    assert.equal(shell.stdout.trim(), "bash vi");
  });
