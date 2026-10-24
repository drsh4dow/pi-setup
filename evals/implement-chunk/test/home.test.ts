// The run home on a fake real home whose `~/.pi` is a git repository: the arm's harness arrives as
// copies, a write to the copy never reaches the arm, no git started inside the home finds the
// live or the arm's repository, and credentials stay shared with the live agent dir.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { harnessDigest, prepareRunHome, runHomeEnv } from "../home.ts";

const scratch = mkdtempSync(join(tmpdir(), "ic-home-test-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function gitInit(dir: string) {
  execFileSync("git", ["init", "-q", dir]);
}

const realHome = join(scratch, "real");

const live = join(realHome, ".pi");

const arm = join(scratch, "arm");

write(join(live, "agent", "SYSTEM.md"), "live system prompt");

write(join(live, "agent", "auth.json"), "{}");

write(join(live, "agent", "settings.json"), "{}");

write(join(live, "agent", "extensions", "tool.ts"), "export default () => {};");

write(join(live, "agent", "skills", "s", "SKILL.md"), "live skill");

write(join(live, "node_modules", "effect", "index.js"), "");

write(join(live, "README.md"), "live checkout");

gitInit(live);

write(join(realHome, ".gitconfig"), "");

write(join(realHome, ".local", "bin", "tool"), "");

write(join(arm, "agent", "SYSTEM.md"), "arm system prompt");

write(join(arm, "agent", "skills", "s", "SKILL.md"), "arm skill");

write(join(arm, "agent", "prompts", "implement-chunk.md"), "arm prompt");

write(join(arm, "agent", "reference.md"), "an arm-only file");

gitInit(arm);

const home = prepareRunHome({ armRoot: arm, home: join(scratch, "run", "home"), realHome });

const env = { ...process.env, ...runHomeEnv(home, realHome) };

describe("the run home", () => {
  test("carries the arm's harness, including a file only the arm has", () => {
    assert.equal(readFileSync(join(home.agentDir, "SYSTEM.md"), "utf8"), "arm system prompt");
    assert.equal(readFileSync(join(home.agentDir, "skills", "s", "SKILL.md"), "utf8"), "arm skill");
    assert.equal(readFileSync(join(home.agentDir, "reference.md"), "utf8"), "an arm-only file");
    assert.equal(
      harnessDigest(home.agentDir, home.armEntries),
      harnessDigest(join(arm, "agent"), home.armEntries),
    );
  });

  test("a write to the run's harness lands in the copy, not in the arm, and changes the digest", () => {
    const before = harnessDigest(home.agentDir, home.armEntries);

    writeFileSync(join(home.agentDir, "prompts", "implement-chunk.md"), "edited by the run");

    assert.equal(
      readFileSync(join(arm, "agent", "prompts", "implement-chunk.md"), "utf8"),
      "arm prompt",
    );
    assert.notEqual(harnessDigest(home.agentDir, home.armEntries), before);
  });

  test("no git started inside the home finds a repository, even through a link into the live checkout", () => {
    for (const dir of [
      join(home.home, ".pi"),
      home.agentDir,
      join(home.agentDir, "skills"),
      join(home.home, ".pi", "node_modules"),
    ]) {
      const found = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: dir,
        env,
        encoding: "utf8",
      });

      assert.notEqual(found.status, 0, `${dir} reaches ${found.stdout.trim()}`);
    }
  });

  test("the live checkout's other files stay out, and the live agent files are copies", () => {
    assert.throws(() => readFileSync(join(home.home, ".pi", "README.md")));
    writeFileSync(join(home.agentDir, "settings.json"), '{"run":true}');
    assert.equal(readFileSync(join(live, "agent", "settings.json"), "utf8"), "{}");
  });

  test("credentials stay shared, so a token the run refreshes reaches the live agent dir", () => {
    writeFileSync(join(home.agentDir, "auth.json"), '{"refreshed":true}');

    assert.equal(readFileSync(join(live, "agent", "auth.json"), "utf8"), '{"refreshed":true}');
  });
});
