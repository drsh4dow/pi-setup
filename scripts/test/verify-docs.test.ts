import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { EVAL_FIXTURE_FOLDERS } from "../eval-fixture-folders.ts";

const checker = new URL("../verify-docs.ts", import.meta.url).pathname;

function repository(t: TestContext, inventory: string, extraFiles: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "verify-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const files = {
    "README.md": "# Setup\n",
    "docs/inventory.md": inventory,
    "agent/extensions/example/index.ts": "",
    "agent/skills/example/SKILL.md": "# Example\n",
    "agent/prompts/example.md": "# Example\n",
    "agent/themes/example.json": "{}\n",
    ...extraFiles,
  };

  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, contents);
  }

  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });

  return root;
}

const validInventory = `# Inventory

### Installed extensions

- \`example\`

### Installed skills

- \`example\`

### Installed prompts

- \`example\`

### Installed themes

- \`example\`
`;

function run(root: string) {
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: "utf8",
  });
}

test("accepts matching tracked inventory and resolving links", (t) => {
  const root = repository(t, `${validInventory}\n[Guide](guide.md#start)\n`, {
    "docs/guide.md": "# Start\n\n[Setup](../README.md)\n",
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("checks unstaged skills and their links while excluding ignored files", (t) => {
  const root = repository(
    t,
    validInventory.replace("### Installed skills", "### Installed skills\n\n- `new`"),
    { ".gitignore": "agent/skills/ignored/\n" },
  );

  for (const name of ["new", "ignored"]) {
    const directory = join(root, "agent/skills", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), "# Skill\n");
  }

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);

  writeFileSync(join(root, "agent/skills/new/SKILL.md"), "[Missing](missing.md)\n");
  const broken = run(root);
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /agent\/skills\/new\/SKILL\.md.*missing\.md/);
});

test("ignores example links and headings inside fenced code", (t) => {
  const root = repository(t, validInventory, {
    "docs/guide.md": [
      "````md",
      "```md",
      "[Example](missing.md)",
      "```",
      "````",
      "   ~~~md",
      "[example]: also-missing.md",
      "# Start",
      "   ~~~~",
      "# Start",
      "[Real](#start)",
    ].join("\n"),
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("still checks links after a fenced example", (t) => {
  const root = repository(t, validInventory, {
    "docs/guide.md": "```md\n[Example](ignored.md)\n```\n[Real](missing.md)\n",
  });

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing\.md/);
  assert.doesNotMatch(result.stderr, /ignored\.md/);
});

test("reports a broken link in any tracked Markdown file", (t) => {
  const root = repository(t, validInventory, {
    "docs/guide.md": "[Missing](nested/nope.md)\n",
  });

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /docs\/guide\.md.*nested\/nope\.md/);
});

test("reports broken same-file and cross-file Markdown anchors", (t) => {
  const root = repository(t, `${validInventory}\n[Missing](#absent)\n`, {
    "docs/guide.md": "# Present\n\n[Missing](../README.md#also-absent)\n",
  });

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /docs\/inventory\.md.*#absent/);
  assert.match(result.stderr, /docs\/guide\.md.*README\.md#also-absent/);
});

test("ignores tracked Markdown removed from the working tree", (t) => {
  const root = repository(t, validInventory, { "docs/removed.md": "# Removed\n" });
  rmSync(join(root, "docs/removed.md"));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("includes directly tracked extension files in the inventory", (t) => {
  const root = repository(t, validInventory.replace("- `example`", "- `direct`\n- `example`"), {
    "agent/extensions/direct.ts": "",
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

const brokenReadme = "See [design](docs/design.md).\n";

// Absent from the shared list however it grows, so this case keeps checking an unlisted folder.
const unlistedFolder = `not-${EVAL_FIXTURE_FOLDERS.join("-")}`;

test("skips a broken link under every eval fixture folder", (t) => {
  const root = repository(
    t,
    validInventory,
    Object.fromEntries(
      EVAL_FIXTURE_FOLDERS.map((folder) => [`evals/demo/${folder}/case/README.md`, brokenReadme]),
    ),
  );

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("still checks eval docs outside the eval fixture folders", (t) => {
  const root = repository(t, validInventory, {
    "evals/demo/README.md": brokenReadme,
    "evals/demo/setup/case/README.md": brokenReadme,
    [`evals/demo/${unlistedFolder}/case/README.md`]: brokenReadme,
  });

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.stderr.trim().split("\n").toSorted(), [
    "evals/demo/README.md: broken local link docs/design.md",
    `evals/demo/${unlistedFolder}/case/README.md: broken local link docs/design.md`,
    "evals/demo/setup/case/README.md: broken local link docs/design.md",
  ]);
});

test("reports inventory drift from tracked components", (t) => {
  const root = repository(
    t,
    validInventory.replace(
      "- `example`\n\n### Installed skills",
      "- `missing`\n\n### Installed skills",
    ),
  );

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Installed extensions.*example.*missing/s);
});

// A SKILL.md whose frontmatter sets the given invocation keys, as `key: value` lines.
function skill(frontmatter: Record<string, boolean>) {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);

  return ["---", "description: Example.", ...lines, "---", "", "# Skill", ""].join("\n");
}

// An inventory whose skills section is one table with a Who column, one row per entry.
function whoInventory(rows: Record<string, string>) {
  const table = [
    "| Skill | Who | Use it to |",
    "| ----- | --- | --------- |",
    ...Object.entries(rows).map(([name, who]) => `| \`${name}\` | ${who} | Do a thing |`),
  ].join("\n");

  return validInventory.replace(
    "### Installed skills\n\n- `example`",
    `### Installed skills\n\n#### Build it\n\n${table}`,
  );
}

const skillsByWho = {
  "agent/skills/manual/SKILL.md": skill({ "disable-model-invocation": true }),
  "agent/skills/automatic/SKILL.md": skill({ "user-invokable": false }),
  "agent/skills/either/SKILL.md": skill({}),
  "agent/skills/explicit/SKILL.md": skill({
    "disable-model-invocation": false,
    "user-invokable": true,
  }),
};

test("accepts Who entries that match each skill's frontmatter", (t) => {
  const root = repository(
    t,
    whoInventory({
      automatic: "agent",
      either: "both",
      example: "both",
      explicit: "both",
      manual: "you",
    }),
    skillsByWho,
  );

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("reports each Who entry that disagrees with its skill's frontmatter", (t) => {
  const root = repository(
    t,
    whoInventory({
      automatic: "both",
      either: "you",
      example: "both",
      explicit: "agent",
      manual: "both",
    }),
    skillsByWho,
  );

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.stderr.trim().split("\n").toSorted(), [
    "docs/inventory.md Installed skills: automatic is listed as both, agent/skills/automatic/SKILL.md frontmatter makes it agent",
    "docs/inventory.md Installed skills: either is listed as you, agent/skills/either/SKILL.md frontmatter makes it both",
    "docs/inventory.md Installed skills: explicit is listed as agent, agent/skills/explicit/SKILL.md frontmatter makes it both",
    "docs/inventory.md Installed skills: manual is listed as both, agent/skills/manual/SKILL.md frontmatter makes it you",
  ]);
});

test("lists a skill hidden from the model and from /skill: as the agent's, which reaches it by path", (t) => {
  const library = skill({ "disable-model-invocation": true, "user-invokable": false });

  const listedAsYours = repository(t, whoInventory({ example: "both", library: "you" }), {
    "agent/skills/library/SKILL.md": library,
  });

  const mismatch = run(listedAsYours);
  assert.notEqual(mismatch.status, 0);
  assert.equal(
    mismatch.stderr.trim(),
    "docs/inventory.md Installed skills: library is listed as you, agent/skills/library/SKILL.md frontmatter makes it agent",
  );

  const listedAsTheAgents = repository(t, whoInventory({ example: "both", library: "agent" }), {
    "agent/skills/library/SKILL.md": library,
  });

  const result = run(listedAsTheAgents);
  assert.equal(result.status, 0, result.stderr);
});

test("reports a skill whose frontmatter does not parse instead of crashing", (t) => {
  const root = repository(t, whoInventory({ broken: "both", example: "both" }), {
    "agent/skills/broken/SKILL.md": [
      "---",
      "disable-model-invocation: true",
      "disable-model-invocation: false",
      "---",
      "",
    ].join("\n"),
  });

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^agent\/skills\/broken\/SKILL\.md: frontmatter does not parse: Map keys must be unique/m,
  );
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
