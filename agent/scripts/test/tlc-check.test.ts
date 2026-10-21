import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

const runner = new URL("../../../.agents/scripts/tlc-check", import.meta.url).pathname;

const source = `const LIMIT = 3;
function settle(count: number) {
  return count > LIMIT;
}

/**
 * Delivers one message.
 */
export function deliver(message: string) {
  send(message);
}

// A comment that a blank line separates from its declaration.

export function report() {
  log("report");
}

export default function extension(pi: Pi) {
  pi.on("turn_end", () => {
    reset();
  });

  pi.registerTool({
    name: "bg_example",
    execute() {
      return run();
    },
  });

  pi.registerTool({
    name: "bg_other",
    execute() {
      return other();
    },
  });
}

// Wires the fiber's exit.
fiber.addObserver((exit) => {
  process.exit(exit);
});
process.on("SIGTERM", () => interrupt(fiber));
`;

function tempDir(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "tlc-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

function runCheck(
  t: TestContext,
  citations: readonly string[],
  {
    flags = ["--citations"],
    env = process.env,
  }: { flags?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
) {
  const root = tempDir(t);

  const skill = join(root, ".agents/skills/verify-example");
  mkdirSync(skill, { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/example.ts"), source);
  writeFileSync(join(skill, "Example.cfg"), "\\* expect: holds\n");
  writeFileSync(
    join(skill, "Example.tla"),
    citations.map((citation) => `\\* code: src/example.ts ${citation}\n`).join(""),
  );

  return spawnSync(runner, [...flags, skill, "Example.tla", "Example.cfg"], {
    encoding: "utf8",
    env,
  });
}

test("accepts a citation of any line in the cited definition's scope", (t) => {
  const result = runCheck(t, [
    'deliver "send(message);"',
    'turn_end "reset();"',
    'bg_example "return run();"',
    'deliver " * Delivers one message."',
    'addObserver "// Wires the fiber\'s exit."',
    'LIMIT "const LIMIT = 3;"',
    'addObserver "process.exit(exit);"',
  ]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
});

test("reports a citation of a line just outside the cited definition's scope", (t) => {
  const result = runCheck(t, [
    'deliver "log(\\"report\\");"',
    'turn_end "pi.registerTool({"',
    'bg_example "return other();"',
    'report "// A comment that a blank line separates from its declaration."',
    'LIMIT "return count > LIMIT;"',
    'addObserver "process.on(\\"SIGTERM\\", () => interrupt(fiber));"',
    'missing "anything"',
  ]);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    result.stdout,
    [
      'stale citation: src/example.ts deliver no longer contains: log("report");',
      "stale citation: src/example.ts turn_end no longer contains: pi.registerTool({",
      "stale citation: src/example.ts bg_example no longer contains: return other();",
      "stale citation: src/example.ts report no longer contains: // A comment that a blank line separates from its declaration.",
      "stale citation: src/example.ts LIMIT no longer contains: return count > LIMIT;",
      'stale citation: src/example.ts addObserver no longer contains: process.on("SIGTERM", () => interrupt(fiber));',
      "stale citation: src/example.ts has no definition of missing",
      "check: code that Example.tla models changed. Run .agents/skills/verify-example/scripts/check and follow its SKILL.md.",
      "",
    ].join("\n"),
  );
});

test("stops the full check at a stale citation before fetching TLC", (t) => {
  const cache = tempDir(t);

  const result = runCheck(t, ['deliver "log(\\"report\\");"'], {
    flags: [],
    env: { ...process.env, JAVA: "true", XDG_CACHE_HOME: cache },
  });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /^stale citation: src\/example\.ts deliver no longer contains: log\("report"\);$/m,
  );
  assert.match(result.stdout, /^check: FAILED before model checking/m);
  assert.equal(existsSync(join(cache, "pi-setup")), false);
});
