import { Schema } from "effect";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { renderBrief } from "../briefs.ts";
import { DONT_KNOW, parentOracle, piParent } from "../oracle.ts";
import type { Scenario } from "../scenario.ts";
import { scenarioById } from "../scenarios.ts";

const decodeLogLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ costUsd: Schema.Finite, elapsedSeconds: Schema.Finite })),
);

const scratch: string[] = [];

after(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

/**
 * A `pi` that records the prompt it got, replies with $FAKE_PI_REPLY, and writes a session file
 * with one assistant message costing $0.25 into its --session-dir, as the real pi does.
 */
function fakePi(dir: string): string {
  const path = join(dir, "pi");

  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const sessionDir = args[args.indexOf("--session-dir") + 1];
fs.appendFileSync(${JSON.stringify(join(dir, "prompts.jsonl"))}, JSON.stringify(args.at(-1)) + "\\n");
fs.writeFileSync(sessionDir + "/session.jsonl", JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage: { cost: { total: 0.25 } } } }) + "\\n");
process.stdout.write(process.env.FAKE_PI_REPLY ?? "");
`,
  );
  chmodSync(path, 0o755);

  return path;
}

function setup(
  scenario: Scenario,
  reply: string,
  clock: { now: number },
  learned: Set<number> = new Set(),
) {
  const dir = mkdtempSync(join(tmpdir(), "wq-oracle-"));

  scratch.push(dir);
  process.env.FAKE_PI_REPLY = reply;

  const oracle = parentOracle({
    brief: renderBrief(scenario.brief, "hardened"),
    knowledge: scenario.knowledge,
    model: piParent({
      model: "fake/model",
      thinking: "medium",
      sessionRoot: join(dir, "sessions"),
      piCommand: fakePi(dir),
    }),
    startedAt: 0,
    latencyMs: 0,
    logFile: join(dir, "parent-log.jsonl"),
    onContact: () => {},
    learned: () => learned,
    now: () => clock.now,
  });

  const prompts = () =>
    readFileSync(join(dir, "prompts.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => String(JSON.parse(line)));

  const log = () =>
    readFileSync(join(dir, "parent-log.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => decodeLogLine(line));

  return { oracle, prompts, log };
}

test("the parent answers from its spawn-time knowledge and never sees the graders' key", async () => {
  const scenario = scenarioById("s1-survives");
  const { oracle, prompts, log } = setup(scenario, "Yes, docs/api.md may change.", { now: 5_000 });

  assert.equal(
    await oracle.answer("May I edit docs/api.md?", "ask-parent"),
    "Yes, docs/api.md may change.",
  );

  const [prompt] = prompts();

  for (const fact of scenario.knowledge.atSpawn)
    assert.ok(prompt.includes(fact), `missing fact: ${fact}`);

  for (const gap of scenario.key.gaps)
    assert.ok(!prompt.includes(gap.topic), `the key leaked: ${gap.topic}`);

  assert.ok(prompt.includes("May I edit docs/api.md?"));
  assert.deepEqual(
    log().map((entry) => entry.costUsd),
    [0.25],
  );
});

test("a fact learned mid-run reaches the parent only once it is learned", async () => {
  const scenario = scenarioById("s9-order");
  const order = scenario.knowledge.learned[0];
  const learned = new Set<number>();
  const { oracle, prompts } = setup(scenario, "ACCEPT", { now: 10_000 }, learned);

  await oracle.review("Renamed everything, legacy.js included.");
  learned.add(0);
  await oracle.review("Renamed everything, legacy.js included.");

  const [early, late] = prompts();

  assert.ok(!early.includes(order.fact), "the order was known before it arrived");
  assert.ok(late.includes(order.fact), "the order was missing after it arrived");
});

test("user-only calls reach the parent as user calls, and the key's category labels never do", async () => {
  const scenario = scenarioById("s6-product");

  const { oracle, prompts } = setup(
    scenario,
    "That's the user's call; pick the reversible default and report it.",
    { now: 1000 },
  );

  await oracle.answer("Do lines with the same SKU but different prices merge?", "question-block");

  const [prompt] = prompts();

  assert.ok(prompt.includes(scenario.knowledge.userCalls[0]));
  assert.ok(!prompt.includes("userOnly"));
});

test("answers are cut to three sentences, and an empty reply is 'I don't know'", async () => {
  const scenario = scenarioById("s8-control");
  const long = setup(scenario, "One. Two is docs/api.md here. Three. Four.", { now: 0 });

  assert.equal(
    await long.oracle.answer("q?", "ask-parent"),
    "One. Two is docs/api.md here. Three.",
  );

  const empty = setup(scenario, "", { now: 0 });

  assert.equal(await empty.oracle.answer("q?", "ask-parent"), DONT_KNOW);
});

test("a review returns ACCEPT or one directive, and an unparseable reply accepts", async () => {
  const scenario = scenarioById("s1-survives");

  assert.deepEqual(await setup(scenario, "ACCEPT", { now: 0 }).oracle.review("done"), {
    kind: "accept",
  });
  assert.deepEqual(
    await setup(scenario, "DIRECTIVE: You may edit docs/api.md. Update it and rerun the gate.", {
      now: 0,
    }).oracle.review("blocked"),
    {
      kind: "directive",
      text: "You may edit docs/api.md. Update it and rerun the gate.",
    },
  );
  assert.deepEqual(await setup(scenario, "Looks fine to me", { now: 0 }).oracle.review("done"), {
    kind: "accept",
  });
});
