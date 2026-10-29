import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { composePrompt, promptPlan, PromptSourceError } from "../generate-prompts.ts";

const generator = fileURLToPath(new URL("../generate-prompts.ts", import.meta.url));

const CORE = [
  "identity line",
  "",
  "<!-- slot: workflow -->",
  "",
  "<rules>",
  "shared rules",
  "</rules>",
  "",
  "<!-- slot: conduct -->",
  "",
  "<context>",
  "shared context",
  "</context>",
  "",
].join("\n");

const GENERAL = [
  "<!-- slot: workflow -->",
  "<workflow>",
  "general workflow",
  "</workflow>",
  "",
  "<!-- slot: conduct -->",
  "<conduct>",
  "general conduct",
  "</conduct>",
  "",
].join("\n");

test("a prompt is the core with each slot line replaced by its part's section", () => {
  assert.equal(
    composePrompt(CORE, [GENERAL]),
    [
      "identity line",
      "",
      "<workflow>",
      "general workflow",
      "</workflow>",
      "",
      "<rules>",
      "shared rules",
      "</rules>",
      "",
      "<conduct>",
      "general conduct",
      "</conduct>",
      "",
      "<context>",
      "shared context",
      "</context>",
      "",
    ].join("\n"),
  );
});

test("sections that fill one slot follow part order, and an unfilled slot leaves no trace", () => {
  const shared = "<!-- slot: workflow -->\nshared subagent text\n";
  const role = "<!-- slot: workflow -->\n\nrole text\n\n";

  assert.equal(
    composePrompt(CORE, [shared, role]),
    [
      "identity line",
      "",
      "shared subagent text",
      "",
      "role text",
      "",
      "<rules>",
      "shared rules",
      "</rules>",
      "",
      "<context>",
      "shared context",
      "</context>",
      "",
    ].join("\n"),
  );
});

// Where composePrompt says the failure lies: a part's index, or "core".
function failingSource(compose: () => string) {
  try {
    compose();
  } catch (error) {
    if (error instanceof PromptSourceError) return error.source;

    throw error;
  }

  return "composed";
}

test("a part with text before its first slot line cannot be composed", () => {
  assert.equal(
    failingSource(() =>
      composePrompt(CORE, [GENERAL, "stray line\n<!-- slot: conduct -->\nconduct\n"]),
    ),
    1,
  );
});

test("a part that names a slot the core lacks cannot be composed", () => {
  assert.equal(
    failingSource(() => composePrompt(CORE, ["<!-- slot: tools -->\ntext\n"])),
    0,
  );
});

test("a core without one of the slot lines cannot be composed", () => {
  assert.equal(
    failingSource(() => composePrompt(CORE.replace("<!-- slot: conduct -->\n", ""), [GENERAL])),
    "core",
  );
});

// The general prompt the fixture core and general part build, written out by hand.
const GENERAL_PROMPT = [
  "identity line",
  "",
  "<workflow>",
  "general workflow",
  "</workflow>",
  "",
  "<rules>",
  "shared rules",
  "</rules>",
  "",
  "<conduct>",
  "general conduct",
  "</conduct>",
  "",
  "<context>",
  "shared context",
  "</context>",
  "",
].join("\n");

function repository(t: TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "generate-prompts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }

  execFileSync("git", ["init", "--quiet"], { cwd: root });

  return root;
}

function generate(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [generator, ...args], { cwd: root, encoding: "utf8" });
}

const PARTS = { "agent/system/core.md": CORE, "agent/system/general.md": GENERAL };

test("a hand edit to the general prompt fails the check, which names the generator", (t) => {
  const root = repository(t, { ...PARTS, "agent/SYSTEM.md": `${GENERAL_PROMPT}x` });

  const check = generate(root, "--check");

  assert.equal(check.status, 1);
  assert.equal(
    check.stderr,
    "agent/SYSTEM.md: differs from what scripts/generate-prompts.ts builds from agent/system/core.md, agent/system/general.md. Edit those parts, then run vp run generate:prompts.\n",
  );
  assert.equal(readFileSync(join(root, "agent/SYSTEM.md"), "utf8"), `${GENERAL_PROMPT}x`);
});

test("regenerating after a hand edit writes the prompt the check accepts", (t) => {
  const root = repository(t, { ...PARTS, "agent/SYSTEM.md": `${GENERAL_PROMPT}x` });

  const write = generate(root);

  assert.equal(write.status, 0, write.stderr);
  assert.equal(readFileSync(join(root, "agent/SYSTEM.md"), "utf8"), GENERAL_PROMPT);

  const check = generate(root, "--check");

  assert.deepEqual([check.status, check.stdout, check.stderr], [0, "", ""]);
});

test("a missing general prompt fails the check", (t) => {
  const check = generate(repository(t, PARTS), "--check");

  assert.equal(check.status, 1);
  assert.equal(check.stderr, "agent/SYSTEM.md: missing; run vp run generate:prompts\n");
});

const SUBAGENT_PARTS = {
  "agent/system/subagent.md": "<!-- slot: conduct -->\nnobody answers; report\n",
  "agent/system/kinds/delegate.md": "<!-- slot: workflow -->\ndelegate text\n",
  "agent/system/roles/delegate/implementer.md": "<!-- slot: workflow -->\nimplementer text\n",
};

test("a mode part and each role part get their own prompt built on the core", (t) => {
  const root = repository(t, {
    ...PARTS,
    ...SUBAGENT_PARTS,
    "agent/system/sh4dow.md": "<!-- slot: workflow -->\ncoordinator rules\n",
    "agent/system/roles/owner/babysitter.md": "<!-- slot: workflow -->\nbabysitter text\n",
    "agent/system/kinds/owner.md": "<!-- slot: conduct -->\nowner conduct\n",
    "agent/system/roles/delegate/notes.txt": "not a role part",
  });

  assert.deepEqual(promptPlan(root), [
    { output: "agent/SYSTEM.md", parts: ["agent/system/general.md"] },
    { output: "agent/system/generated/sh4dow.md", parts: ["agent/system/sh4dow.md"] },
    {
      output: "agent/system/generated/delegate/implementer.md",
      parts: [
        "agent/system/subagent.md",
        "agent/system/kinds/delegate.md",
        "agent/system/roles/delegate/implementer.md",
      ],
    },
    {
      output: "agent/system/generated/owner/babysitter.md",
      parts: [
        "agent/system/subagent.md",
        "agent/system/kinds/owner.md",
        "agent/system/roles/owner/babysitter.md",
      ],
    },
  ]);

  assert.equal(generate(root).status, 0);

  const sh4dow = readFileSync(join(root, "agent/system/generated/sh4dow.md"), "utf8");

  const implementer = readFileSync(
    join(root, "agent/system/generated/delegate/implementer.md"),
    "utf8",
  );

  for (const prompt of [sh4dow, implementer]) {
    for (const block of [
      "identity line",
      "<rules>\nshared rules\n</rules>",
      "<context>\nshared context\n</context>",
    ]) {
      assert.ok(prompt.includes(block), `missing core block ${block}`);
    }
  }

  assert.equal(
    sh4dow,
    "identity line\n\ncoordinator rules\n\n<rules>\nshared rules\n</rules>\n\n<context>\nshared context\n</context>\n",
  );
  assert.equal(
    implementer,
    "identity line\n\ndelegate text\n\nimplementer text\n\n<rules>\nshared rules\n</rules>\n\nnobody answers; report\n\n<context>\nshared context\n</context>\n",
  );
  assert.deepEqual([generate(root, "--check").status, generate(root, "--check").stderr], [0, ""]);
});

test("a generated prompt whose part was deleted fails the check", (t) => {
  const root = repository(t, {
    ...PARTS,
    "agent/SYSTEM.md": GENERAL_PROMPT,
    "agent/system/generated/delegate/retired.md": "old role prompt",
  });

  for (const args of [["--check"], []]) {
    const run = generate(root, ...args);

    assert.equal(run.status, 1);
    assert.equal(
      run.stderr,
      "agent/system/generated/delegate/retired.md: no part builds this file; delete it or restore its part\n",
    );
  }
});

test("a part that cannot be composed is named, and its prompt is left as it was", (t) => {
  const root = repository(t, {
    ...PARTS,
    "agent/system/general.md": `stray line\n${GENERAL}`,
    "agent/SYSTEM.md": GENERAL_PROMPT,
  });

  const write = generate(root);

  assert.equal(write.status, 1);
  assert.equal(write.stderr, "agent/system/general.md: has text before its first slot line\n");
  assert.equal(readFileSync(join(root, "agent/SYSTEM.md"), "utf8"), GENERAL_PROMPT);
});

test("a role prompt whose kind part is missing cannot be built", (t) => {
  const root = repository(t, {
    ...PARTS,
    "agent/system/subagent.md": SUBAGENT_PARTS["agent/system/subagent.md"],
    "agent/system/roles/delegate/implementer.md":
      SUBAGENT_PARTS["agent/system/roles/delegate/implementer.md"],
    "agent/SYSTEM.md": GENERAL_PROMPT,
  });

  const check = generate(root, "--check");

  assert.equal(check.status, 1);
  assert.equal(
    check.stderr,
    "agent/system/generated/delegate/implementer.md: cannot build, agent/system/kinds/delegate.md is missing\n",
  );
});
