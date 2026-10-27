import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";

import { JAVA_TOOL, TLC_TOOL } from "../../agent/skills/statechart/scripts/tlc-tools.ts";

const repo = realpathSync(new URL("../..", import.meta.url).pathname);

const setup = join(repo, "scripts", "setup.sh");

function scratch(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "setup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  return root;
}

function executable(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function pins(tier: string) {
  const toml = readFileSync(join(repo, "mise", tier, "mise.toml"), "utf8");

  return new Map(
    toml.split("\n").flatMap((line) => {
      const match = /^(?:"([^"]+)"|([\w.-]+))\s*=\s*"([^"]+)"$/.exec(line.trim());

      return match ? [[match[1] ?? match[2], match[3]] as const] : [];
    }),
  );
}

test("mise pins the Pi version that bun.lock tests the extensions against", () => {
  const lock = readFileSync(join(repo, "bun.lock"), "utf8");
  const locked = /"@earendil-works\/pi-coding-agent@([^"]+)"/.exec(lock)?.[1];
  assert.equal(pins("core").get("pi"), locked);
});

test("the formal tier installs the exact TLC and Java the statechart skill looks up", () => {
  const [tlc, version] = TLC_TOOL.split(/@(?=[^@]+$)/);
  const [java, javaVersion] = JAVA_TOOL.split("@");
  const formal = pins("formal");
  assert.equal(formal.get(tlc), version);
  assert.equal(formal.get(java), javaVersion);
});

function runSetup(t: TestContext, args: string[], prepare?: (home: string) => void) {
  const home = scratch(t);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const calls = join(home, "mise-calls");
  // A fake mise that records each call. A node-broken file makes Node.js fail the way a missing
  // libatomic does.
  executable(
    join(bin, "mise"),
    `echo "$*" >> "${calls}"
if [ "$*" = "exec -- node --version" ] && [ -e "$HOME/node-broken" ]; then
  echo "node: error while loading shared libraries: libatomic.so.1" >&2
  exit 127
fi`,
  );
  prepare?.(home);

  const env = {
    HOME: home,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    MISE_CONFIG_DIR: join(home, "mise"),
  };

  const run = (extra: string[] = args) =>
    spawnSync("bash", [setup, ...extra], { env, encoding: "utf8" });

  const miseCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []);

  return { home, run, miseCalls, confD: join(home, "mise", "conf.d") };
}

test("setup links core and the named tiers into mise's conf.d, then installs", (t) => {
  const { run, miseCalls, confD } = runSetup(t, ["formal"]);
  const result = run();
  assert.equal(result.status, 0, result.stderr);

  assert.equal(readlinkSync(join(confD, "pi-setup-core")), join(repo, "mise", "core"));
  assert.equal(readlinkSync(join(confD, "pi-setup-formal")), join(repo, "mise", "formal"));
  assert.equal(existsSync(join(confD, "pi-setup-video")), false);
  assert.deepEqual(miseCalls(), [
    "install",
    "exec -- vp env setup",
    "exec -- node --version",
    "exec -- vp install --frozen-lockfile",
  ]);
});

test("setup stops before vp install when Node.js cannot start, and names the fix", (t) => {
  const { run, miseCalls } = runSetup(t, [], (home) =>
    writeFileSync(join(home, "node-broken"), ""),
  );

  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /libatomic\.so\.1/);
  assert.match(result.stderr, /apt-get install -y libatomic1/);
  assert.ok(!miseCalls().some((call) => call.includes("vp install")));
});

test("setup run again keeps earlier tiers and changes no link", (t) => {
  const { run, confD } = runSetup(t, ["browser"]);
  assert.equal(run().status, 0);
  const before = lstatSync(join(confD, "pi-setup-browser")).ino;

  const again = run([]);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /linked/);
  assert.equal(lstatSync(join(confD, "pi-setup-browser")).ino, before);
  assert.match(again.stdout, /done/);
});

test("setup installs the browser only once the browser tier is linked", (t) => {
  const { run, miseCalls } = runSetup(t, ["browser"]);
  assert.equal(run().status, 0);
  assert.ok(miseCalls().includes("exec -- agent-browser install"));
});

test("setup leaves a conf.d entry it did not create alone, and says so", (t) => {
  const { run, miseCalls, confD } = runSetup(t, [], () => undefined);
  mkdirSync(join(confD, "pi-setup-core"), { recursive: true });

  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists and is not a link/);
  assert.ok(lstatSync(join(confD, "pi-setup-core")).isDirectory());
  assert.deepEqual(miseCalls(), []);
});

test("setup rejects an unknown tier before it changes anything", (t) => {
  const { run, miseCalls, confD } = runSetup(t, ["nope"]);
  const result = run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no tier named nope/);
  assert.equal(existsSync(confD), false);
  assert.deepEqual(miseCalls(), []);
});

test("setup links ~/.agents/skills only when asked, and never over an existing one", (t) => {
  const fresh = runSetup(t, ["--link-agent-skills"]);
  assert.equal(fresh.run().status, 0);
  assert.equal(readlinkSync(join(fresh.home, ".agents", "skills")), join(repo, "agent", "skills"));

  const unasked = runSetup(t, []);
  assert.equal(unasked.run().status, 0);
  assert.equal(existsSync(join(unasked.home, ".agents", "skills")), false);

  const taken = runSetup(t, ["--link-agent-skills"], (home) =>
    mkdirSync(join(home, ".agents", "skills"), { recursive: true }),
  );

  const result = taken.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.agents\/skills already exists/);
  assert.ok(lstatSync(join(taken.home, ".agents", "skills")).isDirectory());
});
