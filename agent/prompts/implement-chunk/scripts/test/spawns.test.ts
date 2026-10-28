import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SPAWNS_HEADER, cli, promptsDir, run, scratch } from "./harness.ts";

const OWNER = "0c9f2b9e-8a46-4b8e-9d3c-2f6f8f0d1a01";

const DELEGATE = "5b1d7e43-1f0a-4c2e-a6a9-77c3b0e5d902";

const SH4DOW_PROMPT = join(promptsDir, "..", "system", "sh4dow.md");

function registry(state: string): string[][] {
  return readFileSync(join(state, "spawns.tsv"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\t"));
}

function addOwner(state: string) {
  return run([
    "--state",
    state,
    "spawn",
    "add",
    OWNER,
    "parent=root",
    "kind=owner",
    "role=final-pr-owner",
    "depth=1",
    "unit=final-a",
    "name=subagent: final PR A",
  ]);
}

test("spawn add registers a subagent as running, with its parent, kind, role, and depth", (t) => {
  const state = scratch(t);
  const added = addOwner(state);

  assert.equal(added.status, 0, added.stderr);

  const [header, row, ...rest] = registry(state);

  assert.equal(header?.join("\t"), SPAWNS_HEADER);
  assert.deepEqual(row?.slice(0, 8), [
    OWNER,
    "root",
    "owner",
    "final-pr-owner",
    "1",
    "final-a",
    "subagent: final PR A",
    "running",
  ]);
  assert.match(row?.[8] ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  assert.deepEqual(rest, []);
});

test("an owner's delegate is registered under the owner's session, and its end under its own", (t) => {
  const state = scratch(t);

  assert.equal(addOwner(state).status, 0);

  const delegate = run([
    "--state",
    state,
    "spawn",
    "add",
    DELEGATE,
    `parent=${OWNER}`,
    "kind=delegate",
    "role=implementer",
    "depth=2",
    "name=subagent: ticket 3",
  ]);

  assert.equal(delegate.status, 0, delegate.stderr);

  const ended = run(["--state", state, "spawn", "set", DELEGATE, "state=reported"]);

  assert.equal(ended.status, 0, ended.stderr);

  const rows = registry(state).slice(1);

  assert.deepEqual(
    rows.map((row) => row.slice(0, 8)),
    [
      [OWNER, "root", "owner", "final-pr-owner", "1", "final-a", "subagent: final PR A", "running"],
      [DELEGATE, OWNER, "delegate", "implementer", "2", "-", "subagent: ticket 3", "running"],
      [DELEGATE, OWNER, "delegate", "implementer", "2", "-", "subagent: ticket 3", "reported"],
    ],
    "set appends the session's whole row with the change, and the last row per session stands",
  );
});

test("spawn refuses a value outside the registry's vocabulary and writes nothing", (t) => {
  const state = scratch(t);

  const base = [
    "--state",
    state,
    "spawn",
    "add",
    OWNER,
    "parent=root",
    "role=implementer",
    "name=n",
  ];

  const refused = [
    [...base, "kind=worker", "depth=1"],
    [...base, "kind=delegate", "depth=0"],
    [...base, "kind=delegate", "depth=two"],
    [...base, "kind=delegate", "depth=1", "state=done"],
    [...base, "kind=delegate", "depth=1", "colour=blue"],
    [...base, "kind=delegate", "depth=1", "recorded_at=2026-01-01T00:00:00Z"],
    [...base, "kind=delegate", "depth=1", "name=a\tb"],
    [...base, "kind=delegate"],
    ["--state", state, "spawn", "add", "", "parent=root"],
  ];

  for (const args of refused) {
    const result = run(args);

    assert.equal(result.status, 2, `${args.slice(4).join(" ")}: ${result.stdout}`);
    assert.match(result.stderr, /^refused: /);
  }

  assert.deepEqual(readdirSync(state), [], "no registry was created");
});

test("spawn set refuses an unknown session and a second add refuses a known one", (t) => {
  const state = scratch(t);

  assert.equal(addOwner(state).status, 0);

  const before = readFileSync(join(state, "spawns.tsv"), "utf8");
  const unknown = run(["--state", state, "spawn", "set", DELEGATE, "state=failed"]);
  const again = addOwner(state);
  const bad = run(["--state", state, "spawn", "set", OWNER, "state=merged"]);
  const empty = run(["--state", state, "spawn", "set", OWNER]);

  for (const result of [unknown, again, bad, empty]) assert.equal(result.status, 2, result.stdout);

  assert.match(unknown.stderr, new RegExp(`no spawn ${DELEGATE}`));
  assert.match(again.stderr, new RegExp(`spawn ${OWNER} exists`));
  assert.match(bad.stderr, /running, reported, failed, reconciled/);
  assert.equal(readFileSync(join(state, "spawns.tsv"), "utf8"), before);
});

test("spawn set refuses a change to the recorded kind, role, or unit, each alone, and writes nothing", (t) => {
  const state = scratch(t);

  assert.equal(addOwner(state).status, 0);

  const before = readFileSync(join(state, "spawns.tsv"), "utf8");

  for (const change of ["kind=delegate", "role=babysitter", "unit=final-b"]) {
    const result = run(["--state", state, "spawn", "set", OWNER, change]);
    const column = change.split("=")[0] ?? "";

    assert.equal(result.status, 2, `${change}: ${result.stdout}`);
    assert.match(result.stderr, new RegExp(`recorded with ${column}=`), change);
  }

  assert.equal(readFileSync(join(state, "spawns.tsv"), "utf8"), before);

  const same = run([
    "--state",
    state,
    "spawn",
    "set",
    OWNER,
    "kind=owner",
    "role=final-pr-owner",
    "unit=final-a",
    "state=reported",
  ]);

  assert.equal(same.status, 0, same.stderr);
  assert.equal(
    registry(state).at(-1)?.[7],
    "reported",
    "the recorded identity with a new state is accepted",
  );
});

test("spawn refuses a registry row it cannot read", (t) => {
  const state = scratch(t);

  assert.equal(addOwner(state).status, 0);

  appendFileSync(
    join(state, "spawns.tsv"),
    `${DELEGATE}\troot\tdelegate\tverifier\t1\t-\tn\tlost\t-\n`,
  );

  const result = run(["--state", state, "spawn", "set", OWNER, "state=reported"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /spawns\.tsv:3: .*lost/);
});

test("spawns registered at once all land, under one header", async (t) => {
  const state = scratch(t);
  const sessions = Array.from({ length: 8 }, (_, index) => `session-${index}`);

  await Promise.all(
    sessions.map(
      (session) =>
        new Promise<void>((done, fail) => {
          const child = spawn(cli, [
            "--state",
            state,
            "spawn",
            "add",
            session,
            "parent=root",
            "kind=delegate",
            "role=implementer",
            "depth=1",
            `name=${session}`,
          ]);

          child.on("error", fail);
          child.on("close", (code) =>
            code === 0 ? done() : fail(new Error(`${session} exited ${code}`)),
          );
        }),
    ),
  );

  const [header, ...rows] = registry(state);

  assert.equal(header?.join("\t"), SPAWNS_HEADER);
  assert.deepEqual(
    rows.map((row) => row[0] ?? "").toSorted((a, b) => a.localeCompare(b)),
    sessions,
  );
  assert.equal(existsSync(join(state, "spawns.tsv.tmp")), false);
  assert.deepEqual(readdirSync(state), ["spawns.tsv"]);
});

test("the sh4dow prompt names the registry's columns and states", () => {
  const prompt = readFileSync(SH4DOW_PROMPT, "utf8");

  assert.equal(
    prompt
      .match(/`spawns.tsv` columns: `([^`]+)`/)?.[1]
      ?.split(" ")
      .join("\t"),
    SPAWNS_HEADER,
  );
  assert.equal(
    prompt.match(/`spawns.tsv` states: `([^`]+)`/)?.[1],
    "running reported failed reconciled",
  );
});

test("the sh4dow prompt lists every owner role the launcher knows among its roles", () => {
  const prompt = readFileSync(SH4DOW_PROMPT, "utf8");
  const section = prompt.split(/^## Your role$/m)[1]?.split(/^## /m)[0] ?? "";
  const listed = [...section.matchAll(/^- `([a-z-]+)`:/gm)].map((match) => match[1] ?? "");
  const rolesDir = join(promptsDir, "..", "system", "roles");

  const roleNames = (kind: string) =>
    readdirSync(join(rolesDir, kind)).map((file) => file.replace(/\.md$/, ""));

  for (const owner of roleNames("owner")) assert.ok(listed.includes(owner), owner);

  for (const role of listed) {
    assert.ok([...roleNames("owner"), ...roleNames("delegate")].includes(role), role);
  }
});
