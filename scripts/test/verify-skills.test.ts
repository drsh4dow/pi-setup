import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { EVAL_FIXTURE_FOLDERS } from "../eval-fixture-folders.ts";

const checker = new URL("../verify-skills.ts", import.meta.url).pathname;

function repository(t: TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "verify-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, contents, { mode: 0o644 });
  }

  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });

  return root;
}

const INVOCATION_FLAGS = "disable-model-invocation: false\nuser-invokable: false\n";

function skillManifest(path: string, description: string, flags = INVOCATION_FLAGS) {
  return `---\nname: ${basename(dirname(path))}\ndescription: ${description}\n${flags}---\n`;
}

function run(cwd: string) {
  return spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" });
}

function assertNamesFix(stderr: string, scripts: readonly string[]) {
  for (const script of scripts) {
    assert.match(stderr, new RegExp(`${script}: .*Run: chmod \\+x ${script} && git add ${script}`));
  }
}

test("requires the executable bit on shebang skill scripts in the index and on disk", (t) => {
  const scripts = [
    "agent/skills/example/scripts/log.sh",
    ".agents/skills/verify-example/scripts/check",
  ];

  const root = repository(t, {
    [scripts[0]]: "#!/usr/bin/env bash\n",
    [scripts[1]]: "#!/usr/bin/env node\n",
    "agent/skills/example/SKILL.md": skillManifest(
      "agent/skills/example/SKILL.md",
      "An example skill.",
    ),
    ".agents/skills/verify-example/SKILL.md":
      "---\nname: verify-example\ndescription: Verify the example app.\n---\n",
    "agent/skills/example/scripts/data.tsv": "phase\tdecision\n",
    "scripts/tool.ts": "#!/usr/bin/env node\n",
  });

  const missing = run(join(root, "agent"));
  assert.notEqual(missing.status, 0);
  assertNamesFix(missing.stderr, scripts);
  assert.doesNotMatch(missing.stderr, /data\.tsv|scripts\/tool\.ts/);

  execFileSync("git", ["update-index", "--chmod=+x", ...scripts], { cwd: root });
  const indexOnly = run(root);
  assert.notEqual(indexOnly.status, 0);
  assertNamesFix(indexOnly.stderr, scripts);

  for (const script of scripts) chmodSync(join(root, script), 0o755);
  execFileSync("git", ["add", ...scripts], { cwd: root });
  const executable = run(root);
  assert.equal(executable.status, 0, executable.stderr);
});

test("fails on SKILL.md frontmatter that Pi drops or that names another directory", (t) => {
  const unparsable = [
    "agent/skills/docs-search/SKILL.md",
    "agent/skills/group/nested/SKILL.md",
    "agent/skills/untracked/SKILL.md",
  ];

  const misnamed = ".agents/skills/verify-example/SKILL.md";
  const unquotedColon = "Use before building on a platform API: to check";

  const root = repository(t, {
    [unparsable[0]]: skillManifest(unparsable[0], unquotedColon),
    [unparsable[1]]: skillManifest(unparsable[1], unquotedColon),
    [misnamed]: "---\nname: verify-other\ndescription: Verify the example app.\n---\n",
    "agent/skills/valid/SKILL.md": skillManifest("agent/skills/valid/SKILL.md", "A valid skill."),
  });

  mkdirSync(join(root, dirname(unparsable[2])));
  writeFileSync(join(root, unparsable[2]), skillManifest(unparsable[2], unquotedColon));

  const result = run(root);
  assert.notEqual(result.status, 0);

  for (const manifest of unparsable) {
    assert.match(result.stderr, new RegExp(`^${manifest}: `, "m"));
  }

  assert.match(
    result.stderr,
    new RegExp(`${misnamed}: name "verify-other" does not match its directory "verify-example"`),
  );
  assert.doesNotMatch(result.stderr, /skills\/valid\//);

  for (const manifest of unparsable) {
    writeFileSync(join(root, manifest), skillManifest(manifest, '"Use before: check"'));
  }

  writeFileSync(
    join(root, misnamed),
    "---\nname: verify-example\ndescription: Verify the example app.\n---\n",
  );
  const fixed = run(root);
  assert.equal(fixed.status, 0, fixed.stderr);
});

test("fails on every skill pointer in Markdown that names a skill Pi does not load", (t) => {
  const how = "agent/skills/how/SKILL.md";
  const proveItWorks = "agent/skills/principle-prove-it-works/SKILL.md";
  const pointing = "agent/skills/pointing/SKILL.md";
  const readme = "README.md";

  const root = repository(t, {
    [how]: skillManifest(how, "Explain a subsystem."),
    [proveItWorks]: skillManifest(proveItWorks, "Verify the real thing."),
    [pointing]: [
      skillManifest(pointing, "Points at other skills."),
      "Run the **how** skill, per the **prove-it-works** principle skill.",
      "Then run the **interrogate** skill.",
      "Apply the **how** and **show-me-your-work** skills, per the **gone** principle skill.",
      "Validate per **principle-boundary-discipline**.",
      "A **model-invoked** skill keeps its description.",
      "Type `'/skill:ho'` and pick `/skill:how`.",
      "",
    ].join("\n"),
    [readme]: "Run `/skill:figure-it-out` on the migration.\n",
  });

  const result = run(root);
  assert.notEqual(result.status, 0);

  const dangling = result.stderr.split("\n").filter((line) => line.includes("points to skill"));
  assert.deepEqual(dangling.toSorted(), [
    `${readme}:1: points to skill "figure-it-out", which Pi does not load`,
    `${pointing}:10: points to skill "principle-gone", which Pi does not load`,
    `${pointing}:10: points to skill "show-me-your-work", which Pi does not load`,
    `${pointing}:11: points to skill "principle-boundary-discipline", which Pi does not load`,
    `${pointing}:9: points to skill "interrogate", which Pi does not load`,
  ]);

  for (const name of ["interrogate", "show-me-your-work", "principle-gone", "figure-it-out"]) {
    const path = `agent/skills/${name}/SKILL.md`;
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), skillManifest(path, "Now loaded."));
  }

  const boundary = "agent/skills/principle-boundary-discipline/SKILL.md";
  mkdirSync(join(root, dirname(boundary)));
  writeFileSync(join(root, boundary), skillManifest(boundary, "Validate at boundaries."));

  const fixed = run(root);
  assert.equal(fixed.status, 0, fixed.stderr);
});

test("skips skill pointers under every eval fixture folder and checks the rest of evals", (t) => {
  const how = "agent/skills/how/SKILL.md";
  const pointer = "Run the **gone** skill.\n";

  const root = repository(t, {
    [how]: skillManifest(how, "Explain a subsystem."),
    ...Object.fromEntries(
      EVAL_FIXTURE_FOLDERS.map((folder) => [`evals/demo/${folder}/case/README.md`, pointer]),
    ),
    "evals/demo/README.md": pointer,
  });

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.equal(
    result.stderr.trim(),
    'evals/demo/README.md:1: points to skill "gone", which Pi does not load',
  );
});

test("fails on an agent/skills SKILL.md that leaves an invocation flag to its default", (t) => {
  const unflagged = "agent/skills/unflagged/SKILL.md";
  const halfFlagged = "agent/skills/half-flagged/SKILL.md";
  const quoted = "agent/skills/quoted/SKILL.md";
  const project = ".agents/skills/verify-example/SKILL.md";

  const root = repository(t, {
    [unflagged]: skillManifest(unflagged, "No flags.", ""),
    [halfFlagged]: skillManifest(halfFlagged, "One flag.", "disable-model-invocation: true\n"),
    [quoted]: skillManifest(
      quoted,
      "Quoted flags.",
      'disable-model-invocation: "false"\nuser-invokable: false\n',
    ),
    [project]: skillManifest(project, "Project skills keep the defaults.", ""),
    "agent/prompts/route.md": "Load the **half-flagged** skill.\n",
  });

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.stderr.trim().split("\n").toSorted(), [
    `${halfFlagged}: set "user-invokable" to true or false`,
    `${quoted}: set "disable-model-invocation" to true or false`,
    `${unflagged}: set "disable-model-invocation" to true or false`,
    `${unflagged}: set "user-invokable" to true or false`,
  ]);

  for (const path of [unflagged, halfFlagged, quoted]) {
    writeFileSync(join(root, path), skillManifest(path, "Flagged."));
  }

  const fixed = run(root);
  assert.equal(fixed.status, 0, fixed.stderr);
});

test("loads .agents/skills and nested skills in the layout a session uses", (t) => {
  const architect = "agent/skills/architect/SKILL.md";
  const guide = ".agents/skills/notes/guide.md";
  const nestedScript = "agent/skills/group/nested/scripts/run.sh";

  const root = repository(t, {
    [architect]: skillManifest(architect, "Sketch types first."),
    [guide]: "---\nname: architect\ndescription: A guide beside no SKILL.md.\n---\n",
    ".agents/skills/readme.md": "---\nname: readme\ndescription: Pi skips this root file.\n---\n",
    "agent/skills/group/nested/SKILL.md": skillManifest(
      "agent/skills/group/nested/SKILL.md",
      "A nested skill.",
    ),
    [nestedScript]: "#!/usr/bin/env bash\n",
  });

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(
      `^${architect}: name "architect" collision\\. Pi drops this file and keeps ${guide}$`,
      "m",
    ),
  );
  assertNamesFix(result.stderr, [nestedScript]);
  assert.doesNotMatch(result.stderr, /readme/);

  rmSync(join(root, guide));
  chmodSync(join(root, nestedScript), 0o755);
  execFileSync("git", ["add", "--all"], { cwd: root });
  const fixed = run(root);
  assert.equal(fixed.status, 0, fixed.stderr);
});

const HIDDEN_FLAGS = "disable-model-invocation: true\nuser-invokable: false\n";

function unreachable(path: string) {
  return `${path}: hidden from the model (disable-model-invocation: true), and no router entry, skill, role prompt, or mode prompt points to it`;
}

test("fails on a hidden skill that no router entry, skill, role prompt, or mode prompt points to", (t) => {
  const library = "agent/skills/library/SKILL.md";
  const visible = "agent/skills/visible/SKILL.md";

  const root = repository(t, {
    [library]: `${skillManifest(library, "A library skill.", HIDDEN_FLAGS)}See ~/.pi/agent/skills/library/SKILL.md.\n`,
    "agent/skills/library/notes.md": "Back to the **library** skill.\n",
    [visible]: skillManifest(visible, "A visible skill."),
    "README.md": "Read `~/.pi/agent/skills/library/SKILL.md`, or run `/skill:library`.\n",
    "docs/guide.md": "Use the **library** skill.\n",
  });

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.trim(), unreachable(library));
});

test("passes once a router entry, skill, role prompt, or mode prompt points to a hidden skill", (t) => {
  const library = "agent/skills/library/SKILL.md";
  const visible = "agent/skills/visible/SKILL.md";

  const pointers = {
    "agent/system/general.md": "| Write a spec | `~/.pi/agent/skills/library/SKILL.md` |\n",
    "agent/SYSTEM.md": "| Write a spec | `~/.pi/agent/skills/library/SKILL.md` |\n",
    "agent/system/roles/delegate/implementer.md": "Load the **library** skill.\n",
    "agent/system/sh4dow.md": "Run `/skill:library` first.\n",
    "agent/prompts/handoff.md": "Then load the **library** skill.\n",
    [visible]: `${skillManifest(visible, "A visible skill.")}Read ~/.pi/agent/skills/library/SKILL.md.\n`,
  };

  for (const [path, pointer] of Object.entries(pointers)) {
    const root = repository(t, {
      [library]: skillManifest(library, "A library skill.", HIDDEN_FLAGS),
      [visible]: skillManifest(visible, "A visible skill."),
      [path]: pointer,
    });

    const result = run(root);
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }
});

test("fails on a router path that names a skill Pi does not load", (t) => {
  const visible = "agent/skills/visible/SKILL.md";

  const root = repository(t, {
    [visible]: skillManifest(visible, "A visible skill."),
    "agent/system/general.md": [
      "| Task | Skill |",
      "| --- | --- |",
      "| Explain | `~/.pi/agent/skills/visible/SKILL.md` |",
      "| Write a spec | `~/.pi/agent/skills/gone/SKILL.md` |",
      "",
    ].join("\n"),
  });

  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.equal(
    result.stderr.trim(),
    'agent/system/general.md:4: points to skill "gone", which Pi does not load',
  );
});
