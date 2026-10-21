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
  // Sends the message once.
  send(message);
}

// A comment that a blank line separates from its declaration.

export function report() {
  /* Logs
     the report. */
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
    code = source,
  }: { flags?: readonly string[]; env?: NodeJS.ProcessEnv; code?: string } = {},
) {
  const root = tempDir(t);

  const skill = join(root, ".agents/skills/verify-example");
  mkdirSync(skill, { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/example.ts"), code);
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
    'LIMIT "const LIMIT = 3;"',
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
      "stale citation: src/example.ts has no definition of missing",
      "check: code that Example.tla models changed. Run .agents/skills/verify-example/scripts/check and follow its SKILL.md.",
      "",
    ].join("\n"),
  );
});

test("reports a snippet that only a comment above or inside the definition contains", (t) => {
  const result = runCheck(t, [
    'deliver " * Delivers one message."',
    'deliver "// Sends the message once."',
    'report "the report. */"',
    'top-level "// Wires the fiber\'s exit."',
  ]);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    result.stdout,
    [
      "stale citation: src/example.ts deliver no longer contains:  * Delivers one message.",
      "stale citation: src/example.ts deliver no longer contains: // Sends the message once.",
      "stale citation: src/example.ts report no longer contains: the report. */",
      "stale citation: src/example.ts top-level no longer contains: // Wires the fiber's exit.",
      "check: code that Example.tla models changed. Run .agents/skills/verify-example/scripts/check and follow its SKILL.md.",
      "",
    ].join("\n"),
  );
});

test("reports a name that only a column-0 mention contains as having no definition", (t) => {
  const result = runCheck(t, ['settle "settle(3);"'], {
    code: 'console.log("settle: process.exit(1)");\nsettle(3);\n',
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^stale citation: src\/example\.ts has no definition of settle$/m);
});

test("scopes top-level to module-level statements outside every definition", (t) => {
  const current = runCheck(t, [
    'top-level "fiber.addObserver((exit) => {"',
    'top-level "process.exit(exit);"',
    'top-level "process.on(\\"SIGTERM\\", () => interrupt(fiber));"',
  ]);

  assert.equal(current.status, 0, current.stdout + current.stderr);

  const stale = runCheck(t, ['top-level "send(message);"', 'top-level "const LIMIT = 3;"']);

  assert.equal(stale.status, 1, stale.stderr);
  assert.equal(
    stale.stdout,
    [
      "stale citation: src/example.ts top-level no longer contains: send(message);",
      "stale citation: src/example.ts top-level no longer contains: const LIMIT = 3;",
      "check: code that Example.tla models changed. Run .agents/skills/verify-example/scripts/check and follow its SKILL.md.",
      "",
    ].join("\n"),
  );
});

test("ends a body at the first code line at or left of the definition's indent", (t) => {
  const code = `const LIMIT = 3; // max
function settle(count: number) {
  return count > LIMIT;
}

const launcherExit = (launcherPid: number) =>
  Effect.sleep(INTERVAL).pipe(Effect.repeat({ until: () => !isAlive(launcherPid) }));

const abandonRun = Effect.fn("abandonRun")(function* (runDirectory: string) {
  yield* fs.remove(runDirectory);
});

const watchLauncher = (launcherPid: number, runDirectory: string) =>
  launcherExit(launcherPid).pipe(
    Effect.andThen(abandonRun(runDirectory)),
  );

const usage = \`
help: prints this text
\`;

export function note() {
// A column-0 comment inside the body.
  remember();
}

if (interactive) {
  prompt();
} else {
  exit();
}
`;

  const current = runCheck(
    t,
    [
      'launcherExit "Effect.sleep(INTERVAL).pipe(Effect.repeat({ until: () => !isAlive(launcherPid) }));"',
      'note "remember();"',
      'top-level "exit();"',
    ],
    { code },
  );

  assert.equal(current.status, 0, current.stdout + current.stderr);

  const stale = runCheck(
    t,
    [
      'launcherExit "yield* fs.remove(runDirectory);"',
      'launcherExit "Effect.andThen(abandonRun(runDirectory)),"',
      'LIMIT "return count > LIMIT;"',
      'help "prints this text"',
    ],
    { code },
  );

  assert.equal(stale.status, 1, stale.stderr);
  assert.equal(
    stale.stdout,
    [
      "stale citation: src/example.ts launcherExit no longer contains: yield* fs.remove(runDirectory);",
      "stale citation: src/example.ts launcherExit no longer contains: Effect.andThen(abandonRun(runDirectory)),",
      "stale citation: src/example.ts LIMIT no longer contains: return count > LIMIT;",
      "stale citation: src/example.ts has no definition of help",
      "check: code that Example.tla models changed. Run .agents/skills/verify-example/scripts/check and follow its SKILL.md.",
      "",
    ].join("\n"),
  );
});

test("reports a malformed citation line", (t) => {
  const result = runCheck(t, ['deliver "send(message);"', 'deliver "send(message);']);

  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    result.stdout,
    [
      'stale citation: malformed line, expected \\* code: <file> <function> "<snippet>": \\* code: src/example.ts deliver "send(message);',
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
