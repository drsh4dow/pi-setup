import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Schema } from "effect";

const publisher = new URL(
  "../../agent/skills/writing-good-prs/scripts/publish-pr.ts",
  import.meta.url,
).pathname;

// A stand-in for gh. It records each call, with the content of any --body-file, serves the
// live body from live.md until create or edit publishes, then reads back what they published,
// changed as the readback file says. A fail-<verb> file makes that verb exit 1.
const stubGh = `#!/usr/bin/env node
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const file = (name) => path.join(dir, name);
const read = (name, fallback) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8") : fallback);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const bodyFile = option("--body-file");
fs.appendFileSync(
  file("calls.jsonl"),
  JSON.stringify({ args, body: bodyFile === undefined ? null : fs.readFileSync(bodyFile, "utf8") }) + "\\n",
);
const verb = args[1];
if (fs.existsSync(file("fail-" + verb))) {
  process.stderr.write("gh: HTTP 502\\n");
  process.exit(1);
}
if (verb === "create" || verb === "edit") {
  fs.writeFileSync(file("title.txt"), option("--title"));
  fs.writeFileSync(file("published.md"), fs.readFileSync(bodyFile, "utf8"));
  process.stdout.write("https://github.com/acme/widgets/pull/7\\n");
} else if (verb === "view" && option("--json") === "title,body" && !fs.existsSync(file("published.md"))) {
  process.stdout.write(JSON.stringify({ title: "live title", body: read("live.md", "") }) + "\\n");
} else if (verb === "view" && option("--json") === "title,body") {
  const published = read("published.md", "");
  const mode = read("readback", "exact");
  const body =
    mode === "newline" ? published + "\\n"
    : mode === "crlf" ? published.replaceAll("\\n", "\\r\\n")
    : mode === "changed" ? published.replace("twelve", "ten")
    : published;
  const title = read("title.txt", "");
  process.stdout.write(JSON.stringify({ title: mode === "retitled" ? title + " again" : title, body }) + "\\n");
} else {
  process.stderr.write("stub gh: unexpected call " + args.join(" ") + "\\n");
  process.exit(9);
}
`;

// One gh call the stub logged, with the content of its --body-file.
const Call = Schema.Struct({
  args: Schema.Array(Schema.String),
  body: Schema.NullOr(Schema.String),
});

type Call = typeof Call.Type;

const parseCall = Schema.decodeUnknownSync(Schema.fromJsonString(Call));

type Stub = {
  live?: string;
  readback?: "exact" | "newline" | "crlf" | "changed" | "retitled";
  fail?: string;
};

// Stands in publish-pr's arguments for the path of the body file the test writes.
const bodyFile = Symbol("body file");

// Runs publish-pr with a PATH that holds only the stub gh and node, so no call reaches the real gh.
function publish(
  t: TestContext,
  body: string,
  args: (string | typeof bodyFile)[],
  stub: Stub = {},
) {
  const root = mkdtempSync(join(tmpdir(), "publish-pr-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gh = join(root, "gh");
  writeFileSync(gh, stubGh);
  chmodSync(gh, 0o755);
  symlinkSync(process.execPath, join(root, "node"));

  const stubFiles: [string, string | undefined][] = [
    ["live.md", stub.live],
    ["readback", stub.readback],
    [`fail-${stub.fail}`, stub.fail === undefined ? undefined : ""],
  ];

  for (const [name, content] of stubFiles) {
    if (content !== undefined) writeFileSync(join(root, name), content);
  }

  const file = join(root, "body.md");

  writeFileSync(file, body);

  const result = spawnSync(
    publisher,
    args.map((arg) => (arg === bodyFile ? file : arg)),
    { encoding: "utf8", env: { ...process.env, PATH: root } },
  );

  const log = join(root, "calls.jsonl");

  const calls: Call[] = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => parseCall(line))
    : [];

  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

// The body and the title lengths from the ticket that added this script.
const body = `## Why

Agents that check a PR in a repository with no CI wait twelve minutes for a status table.

## Evidence

\`\`\`text
$ watch-pr --status-only
exit 0
\`\`\`

**Not checked:** nothing.

## Risk

- **Blast radius.** The status command only.
- **Door.** Two-way, a revert undoes it.
- **Merge condition.** None.
`;

const title = "fix(babysit): print a no-checks row at once on repos that lack CI checks";

const longTitle =
  "fix(babysit): watch-pr status-only exits at once with a no-checks row on repos that have no CI";

test("refuses to publish a body check-body rejects, and calls no gh", (t) => {
  const rejected = publish(t, body, ["edit", "7", bodyFile, "--title", longTitle]);

  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /title is 94 characters/);
  assert.deepEqual(rejected.calls, []);
});

test("refuses a bad argument with exit 64, from itself or from check-body, and calls no gh", (t) => {
  const unknown = publish(t, body, ["create", bodyFile, "--title", title, "--draft"]);

  assert.equal(unknown.status, 64);
  assert.match(unknown.stderr, /publish-pr: /);
  assert.deepEqual(unknown.calls, []);

  const missingTemplate = publish(t, body, [
    "create",
    bodyFile,
    "--title",
    title,
    "--template",
    "/nonexistent/template.md",
  ]);

  assert.equal(missingTemplate.status, 64);
  assert.match(missingTemplate.stderr, /check-body: .*cannot read/);
  assert.deepEqual(missingTemplate.calls, []);

  const noTitle = publish(t, body, ["edit", "7", bodyFile]);

  assert.equal(noTitle.status, 64);
  assert.deepEqual(noTitle.calls, []);
});

test("creates a PR from a passing body and reads it back", (t) => {
  const result = publish(t, body, ["create", bodyFile, "--title", title, "--base", "main"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.calls.map((call) => call.args.filter((arg) => !arg.startsWith("/"))),
    [
      ["pr", "create", "--base", "main", "--title", title, "--body-file"],
      ["pr", "view", "https://github.com/acme/widgets/pull/7", "--json", "title,body"],
    ],
  );
  assert.equal(result.calls[0]?.body, body);
  assert.match(result.stdout, /https:\/\/github\.com\/acme\/widgets\/pull\/7/);
});

test("keeps each section a bot added to the live body, in its live position, and names it", (t) => {
  const preview = "## Deploy preview\n\nhttps://preview.example/7\n";

  const plan =
    "## Terraform plan\n\n```text\n## not a heading, inside the plan\nPlan: 1 to add\n```\n";

  const live = body.replace("## Evidence", `${preview}\n## Evidence`) + `\n${plan}`;
  const edited = body.replace("twelve minutes", "twelve minutes per PR");

  const result = publish(t, edited, ["edit", "7", bodyFile, "--title", title], { live });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.calls.map((call) => call.args.filter((arg) => !arg.startsWith("/"))),
    [
      ["pr", "view", "7", "--json", "title,body"],
      ["pr", "edit", "7", "--title", title, "--body-file"],
      ["pr", "view", "7", "--json", "title,body"],
    ],
  );
  assert.equal(
    result.calls[1]?.body,
    `${edited.replace("## Evidence", `${preview}\n## Evidence`)}\n${plan}`,
  );
  assert.equal(
    result.stdout,
    [
      'publish-pr: kept "## Deploy preview" from the live body',
      'publish-pr: kept "## Terraform plan" from the live body',
      "publish-pr: published https://github.com/acme/widgets/pull/7",
      "",
    ].join("\n"),
  );
});

test("publishes the file unchanged when the live body has no section the file lacks", (t) => {
  const edited = body.replace("twelve minutes", "twelve minutes per PR");
  const result = publish(t, edited, ["edit", "7", bodyFile, "--title", title], { live: body });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls[1]?.body, edited);
  assert.doesNotMatch(result.stdout, /kept/);
});

test("accepts a readback that differs from the sent body by one trailing newline", (t) => {
  const result = publish(t, body, ["edit", "7", bodyFile, "--title", title], {
    readback: "newline",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("accepts a readback that stores the sent body with CRLF line ends", (t) => {
  const result = publish(t, body, ["edit", "7", bodyFile, "--title", title], { readback: "crlf" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("fails with exit 3 and names both titles when the readback title changed", (t) => {
  const result = publish(t, body, ["edit", "7", bodyFile, "--title", title], {
    readback: "retitled",
  });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /^publish-pr: title read back as .* again", sent "fix\(babysit\)/m);
  assert.doesNotMatch(result.stdout, /published/);
});

test("fails with exit 3 and the diff when the readback body changed", (t) => {
  const result = publish(t, body, ["edit", "7", bodyFile, "--title", title], {
    readback: "changed",
  });

  assert.equal(result.status, 3);
  assert.match(result.stderr, /^publish-pr: -3: .*wait twelve minutes/m);
  assert.match(result.stderr, /^publish-pr: \+3: .*wait ten minutes/m);
  assert.doesNotMatch(result.stdout, /published/);
});

test("fails with exit 2 when a gh call fails, and reads nothing back", (t) => {
  const result = publish(t, body, ["edit", "7", bodyFile, "--title", title], { fail: "edit" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /gh: HTTP 502/);
  assert.deepEqual(
    result.calls.map((call) => call.args[1]),
    ["view", "edit"],
  );
});
