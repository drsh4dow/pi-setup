// The fake GitHub and tracker behaviors the traps rely on, driven through the `gh` and `tracker`
// executables a run puts on PATH, against a real bare origin.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Schema } from "effect";
import { readTrackerState } from "../tracker.ts";
import { prepareWorld, type World } from "../world.ts";

let scratch: string;

let world: World;

function gh(args: readonly string[], cwd = world.workdir) {
  const result = spawnSync("gh", args, { cwd, env: world.env, encoding: "utf8" });

  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs `gh` and decodes its JSON output as `schema`. */
function ghJson<S extends Schema.Decoder<unknown>>(schema: S, args: readonly string[]): S["Type"] {
  const result = gh(args);

  assert.equal(result.code, 0, result.stderr);

  return Schema.decodeSync(Schema.fromJsonString(schema))(result.stdout);
}

const MergeSettings = Schema.Struct({
  mergeCommitAllowed: Schema.Boolean,
  squashMergeAllowed: Schema.Boolean,
  rebaseMergeAllowed: Schema.Boolean,
});

const Reviews = Schema.Struct({ reviews: Schema.Array(Schema.Struct({ body: Schema.String })) });

const Threads = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        reviewThreads: Schema.Struct({
          nodes: Schema.Array(Schema.Struct({ isResolved: Schema.Boolean })),
        }),
      }),
    }),
  }),
});

function git(args: readonly string[], cwd = world.workdir) {
  return execFileSync("git", args, { cwd, env: world.env, encoding: "utf8" }).trim();
}

function ticketState(key: string) {
  return readTrackerState(world.tracker.state).tickets.find((ticket) => ticket.key === key)?.state;
}

/** Pushes a branch off `base` that adds `file`, and opens a PR for it. */
function openPr({
  branch,
  base,
  file,
  title,
}: {
  branch: string;
  base: string;
  file: string;
  title: string;
}) {
  git(["checkout", "-q", "-b", branch, `origin/${base}`]);
  writeFileSync(join(world.workdir, file), `${branch}\n`);
  git(["add", file]);
  git(["commit", "-qm", title]);
  git(["push", "-q", "origin", branch]);

  const created = gh([
    "pr",
    "create",
    "--base",
    base,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    "Receipt.",
  ]);

  assert.equal(created.code, 0, created.stderr);

  return Number(/\/pull\/(\d+)/.exec(created.stdout)?.[1]);
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "ic-fakegh-test-"));
  world = await prepareWorld({
    armRoot: join(import.meta.dirname, "..", "..", ".."),
    outDir: join(scratch, "out"),
    scratch,
    name: "tally-test",
    delays: { ciDelayMs: 0, botDelayMs: 0 },
  });
  git(["push", "-q", "origin", "main:chunk/TAL-1/length"]);
  git(["fetch", "-q", "origin"]);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

describe("trap T1: the repository allows merge commits only", () => {
  test("repo view reports squash and rebase merges as disallowed", () => {
    assert.deepEqual(
      ghJson(MergeSettings, [
        "repo",
        "view",
        "--json",
        "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
      ]),
      {
        mergeCommitAllowed: true,
        squashMergeAllowed: false,
        rebaseMergeAllowed: false,
      },
    );
  });

  test("a squash merge is refused and leaves the PR open; a merge commit lands it", () => {
    const number = openPr({
      branch: "t1-squash",
      base: "chunk/TAL-1/length",
      file: "t1.txt",
      title: "T1 probe",
    });

    const baseBefore = git(["rev-parse", "origin/chunk/TAL-1/length"]);

    const squash = gh(["pr", "merge", String(number), "--squash"]);

    assert.equal(squash.code, 1);
    assert.match(squash.stderr, /Squash merges are not allowed/);
    assert.equal(
      git(["ls-remote", "origin", "refs/heads/chunk/TAL-1/length"]).split("\t")[0],
      baseBefore,
    );

    const merged = gh(["pr", "merge", String(number), "--merge"]);

    assert.equal(merged.code, 0, merged.stderr);

    const tip = git(["ls-remote", "origin", "refs/heads/chunk/TAL-1/length"]).split("\t")[0];

    git(["fetch", "-q", "origin"]);
    assert.equal(
      git(["rev-list", "--parents", "-n", "1", tip]).split(" ").length,
      3,
      "a two-parent merge commit",
    );
    assert.deepEqual(
      ghJson(Schema.Struct({ state: Schema.String }), [
        "pr",
        "view",
        String(number),
        "--json",
        "state",
      ]),
      { state: "MERGED" },
    );
  });
});

describe("trap T4: the tracker closes linked tickets on any merge or close", () => {
  test("merging an intermediate PR into an integration branch moves its ticket to Done", () => {
    assert.equal(ticketState("TAL-2"), "Todo");

    const number = openPr({
      branch: "tal-2-convert",
      base: "chunk/TAL-1/length",
      file: "t4.txt",
      title: "Convert lengths",
    });

    assert.equal(ticketState("TAL-2"), "Todo", "opening the PR changes nothing");
    assert.equal(gh(["pr", "merge", String(number), "--merge"]).code, 0);
    assert.equal(ticketState("TAL-2"), "Done");
    assert.equal(ticketState("TAL-3"), "Todo", "an unlinked ticket stays");
  });

  test("closing a PR whose body names a ticket moves it to Done", () => {
    git(["checkout", "-q", "-b", "unrelated", "origin/main"]);
    writeFileSync(join(world.workdir, "t4b.txt"), "x\n");
    git(["add", "t4b.txt"]);
    git(["commit", "-qm", "probe"]);
    git(["push", "-q", "origin", "unrelated"]);

    const created = gh([
      "pr",
      "create",
      "--base",
      "main",
      "--title",
      "Probe",
      "--body",
      "Part of TAL-4",
    ]);

    const number = /\/pull\/(\d+)/.exec(created.stdout)?.[1] ?? "";

    assert.equal(gh(["pr", "close", number]).code, 0);
    assert.equal(ticketState("TAL-4"), "Done");
  });

  test("an agent can reset a ticket, and the log tells the integration's change from the agent's", () => {
    const reset = spawnSync("tracker", ["state", "TAL-4", "In Progress"], {
      env: world.env,
      encoding: "utf8",
    });

    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(ticketState("TAL-4"), "In Progress");
  });
});

describe("trap T6: the review bot posts two reviews per head", () => {
  test("a PR into main gets a summary review and an empty-bodied review carrying one finding", () => {
    const number = openPr({
      branch: "final",
      base: "main",
      file: "t6.txt",
      title: "Length conversion API",
    });

    // The bot posts on the first call that sees the head after its delay.
    gh(["pr", "view", String(number)]);

    const { reviews } = ghJson(Reviews, ["pr", "view", String(number), "--json", "reviews"]);

    assert.equal(reviews.length, 2);
    assert.match(reviews[0].body, /Actionable comments posted: 1/);
    assert.equal(reviews[1].body, "");

    const { data } = ghJson(Threads, [
      "api",
      "graphql",
      "-f",
      "query=query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved}}}}}",
      "-f",
      `owner=acme`,
      "-f",
      `repo=${world.name}`,
      "-F",
      `pr=${number}`,
    ]);

    assert.deepEqual(
      data.repository.pullRequest.reviewThreads.nodes.map((thread) => thread.isResolved),
      [false],
    );
  });

  test("an intermediate PR's reviews carry no finding, and a new head gets a new pair", () => {
    const number = openPr({
      branch: "t6-intermediate",
      base: "chunk/TAL-1/length",
      file: "t6b.txt",
      title: "Intermediate",
    });

    gh(["pr", "view", String(number)]);
    writeFileSync(join(world.workdir, "t6b.txt"), "second head\n");
    git(["commit", "-qam", "second head"]);
    git(["push", "-q", "origin", "t6-intermediate"]);
    gh(["pr", "view", String(number)]);
    gh(["pr", "view", String(number)]);

    const { reviews } = ghJson(Reviews, ["pr", "view", String(number), "--json", "reviews"]);

    assert.equal(reviews.length, 4);
    assert.ok(reviews.every((review) => !review.body.includes("Actionable")));
  });
});

describe("CI", () => {
  test("checks run the fixture's check command on the head, for a PR to any base", () => {
    const number = openPr({
      branch: "no-changelog",
      base: "chunk/TAL-1/length",
      file: "src/extra.mjs",
      title: "Touch src",
    });

    const checks = gh(["pr", "checks", String(number), "--json", "name,bucket"]);

    assert.equal(checks.code, 1, "src/ changed without a CHANGELOG entry");
    assert.deepEqual(JSON.parse(checks.stdout), [{ name: "check", bucket: "fail" }]);
  });
});
