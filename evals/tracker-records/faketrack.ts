#!/usr/bin/env node
// A tracker no model has seen, reached only through the "Other" issue tracker record a fixture
// commits. Every call appends one JSON line to $FAKETRACK_LOG, and issues persist in
// $FAKETRACK_STATE, so the grader reads what a skill actually did.
//
//   faketrack create --title <t> --body-file <path|-> [--label <l>] [--parent <id>]
//   faketrack view <id> | search <words> | comment <id> --body-file <path|->
//   faketrack label <id> <label> | block <id> --by <id> | close <id>

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { Schema } from "effect";

const Issue = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  labels: Schema.Array(Schema.String),
  parent: Schema.NullOr(Schema.Int),
  blockedBy: Schema.Array(Schema.Int),
  comments: Schema.Array(Schema.String),
  closed: Schema.Boolean,
});

type Issue = typeof Issue.Type;

const State = Schema.Struct({ issues: Schema.Array(Issue) });

type State = typeof State.Type;

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(State));

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    console.error(`faketrack: ${name} is not set`);
    process.exit(2);
  }

  return value;
}

const statePath = required("FAKETRACK_STATE");

const logPath = required("FAKETRACK_LOG");

function load(): State {
  return existsSync(statePath) ? decodeState(readFileSync(statePath, "utf8")) : { issues: [] };
}

function save(state: State) {
  const tmp = `${statePath}.${process.pid}.tmp`;

  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, statePath);
}

/**
 * Holds the state lock until this process exits, so calls a model runs in parallel apply one at a
 * time instead of overwriting each other's issues. mkdir is atomic: exactly one caller creates it.
 */
function lockState() {
  const lock = `${statePath}.lock`;
  const deadline = Date.now() + 10_000;

  while (!tryMkdir(lock)) {
    if (Date.now() > deadline) fail(`${lock} held for 10s; remove it if no faketrack is running`);

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }

  process.on("exit", () => rmdirSync(lock));
}

/** Creates `path` and reports true, or reports false when another caller already holds it. */
function tryMkdir(path: string): boolean {
  try {
    mkdirSync(path);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;

    throw error;
  }
}

function bodyFrom(path: string | undefined): string {
  if (path === undefined) return "";

  return readFileSync(path === "-" ? 0 : path, "utf8");
}

function fail(message: string): never {
  console.error(`faketrack: ${message}`);
  process.exit(1);
}

function find(state: State, raw: string | undefined): Issue {
  const id = Number(raw?.replace(/^#/, ""));

  return state.issues.find((issue) => issue.id === id) ?? fail(`no issue ${raw}`);
}

function replace(state: State, updated: Issue): State {
  return { issues: state.issues.map((issue) => (issue.id === updated.id ? updated : issue)) };
}

const [command, ...rest] = process.argv.slice(2);

const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    title: { type: "string" },
    "body-file": { type: "string" },
    label: { type: "string", multiple: true },
    parent: { type: "string" },
    by: { type: "string" },
  },
});

lockState();

appendFileSync(logPath, `${JSON.stringify({ command, values, positionals })}\n`);

const state = load();

switch (command) {
  case "create": {
    if (!values.title) fail("create needs --title");

    const parent = values.parent === undefined ? null : find(state, values.parent).id;

    const issue: Issue = {
      id: state.issues.length + 1,
      title: values.title,
      body: bodyFrom(values["body-file"]),
      labels: values.label ?? [],
      parent,
      blockedBy: [],
      comments: [],
      closed: false,
    };

    save({ issues: [...state.issues, issue] });
    console.log(`created #${issue.id}`);
    break;
  }

  case "view": {
    console.log(JSON.stringify(find(state, positionals[0]), null, 2));
    break;
  }

  case "search": {
    const words = positionals.join(" ").toLowerCase();

    const hits = state.issues.filter((issue) =>
      `${issue.title}\n${issue.body}`.toLowerCase().includes(words),
    );

    console.log(JSON.stringify(hits.map(({ id, title, closed }) => ({ id, title, closed }))));
    break;
  }

  case "comment": {
    const issue = find(state, positionals[0]);

    save(
      replace(state, { ...issue, comments: [...issue.comments, bodyFrom(values["body-file"])] }),
    );
    console.log(`commented on #${issue.id}`);
    break;
  }

  case "label": {
    const issue = find(state, positionals[0]);
    const label = positionals[1] ?? fail("label needs a label");

    save(replace(state, { ...issue, labels: [...issue.labels, label] }));
    console.log(`labelled #${issue.id} ${label}`);
    break;
  }

  case "block": {
    const issue = find(state, positionals[0]);
    const blocker = find(state, values.by);

    save(replace(state, { ...issue, blockedBy: [...issue.blockedBy, blocker.id] }));
    console.log(`#${issue.id} is blocked by #${blocker.id}`);
    break;
  }

  case "close": {
    const issue = find(state, positionals[0]);

    save(replace(state, { ...issue, closed: true }));
    console.log(`closed #${issue.id}`);
    break;
  }

  default:
    fail(`unknown command ${command}; try create, view, search, comment, label, block, close`);
}
