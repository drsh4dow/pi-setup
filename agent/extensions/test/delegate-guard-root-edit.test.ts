import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

import delegateGuardExtension from "../delegate-guard.ts";
import { SH4DOW_MODE_ENTRY } from "../sh4dow/index.ts";
import { extensionTestAdapter, unsafeFixture } from "./adapter.ts";
import { decodeDecision, delegateArgv, rootArgv } from "./guard-fixtures.ts";

// The root-edit findings of the coordinator-runs baseline that are real edits, not /tmp
// scratch files: each past coordinator's write or edit outside its state folder.
const RecordedCall = Schema.Struct({
  session: Schema.String,
  entry: Schema.String,
  cwd: Schema.String,
  firstMessage: Schema.String,
  toolName: Schema.Literals(["write", "edit"]),
  path: Schema.String,
});

const recorded = Schema.decodeUnknownSync(Schema.Struct({ calls: Schema.Array(RecordedCall) }))(
  JSON.parse(readFileSync(new URL("fixtures/root-edit.json", import.meta.url), "utf8")),
).calls;

const ROOT_EDIT = /^root-edit: a coordinator is read-only on code/;

type Entries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;

type Entry = Entries[number];

const userMessage = (text: string) =>
  unsafeFixture<Entry>({
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-10-28T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
  });

const sh4dowEntry = unsafeFixture<Entry>({
  type: "custom",
  id: "c1",
  parentId: null,
  timestamp: "2026-10-28T00:00:00.000Z",
  customType: SH4DOW_MODE_ENTRY,
  data: {},
});

function session(argv: readonly string[]) {
  const launchArgv = process.argv;
  process.argv = [...argv];
  const adapter = extensionTestAdapter();

  try {
    delegateGuardExtension(adapter.api);
  } finally {
    process.argv = launchArgv;
  }

  return async (entries: Entries, cwd: string, toolName: string, input: ToolInput) =>
    decodeDecision(
      await adapter.emit(
        "tool_call",
        unsafeFixture<ToolCallEvent>({ type: "tool_call", toolCallId: "call-1", toolName, input }),
        unsafeFixture<ExtensionContext>({
          cwd,
          sessionManager: unsafeFixture<ExtensionContext["sessionManager"]>({
            getEntries: () => entries,
          }),
        }),
      ),
    );
}

// The guard reads only an edit or write call's path.
type ToolInput = Record<string, string>;

const inputOf = (toolName: string, path: string): ToolInput =>
  toolName === "write" ? { path, content: "x" } : { path, oldText: "a", newText: "b" };

test("root-edit: each past coordinator's edit outside its state folder is refused", async () => {
  const call = session(rootArgv);

  assert.equal(recorded.length, 5);

  const decisions = await Promise.all(
    recorded.map((past) =>
      call(
        [userMessage(`${past.firstMessage}\n\nPE-6897`)],
        past.cwd,
        past.toolName,
        inputOf(past.toolName, past.path),
      ),
    ),
  );

  recorded.forEach((past, index) => {
    const decision = decisions[index];

    assert.equal(decision?.block, true, `${past.session} ${past.entry}`);
    assert.match(decision?.reason ?? "", ROOT_EDIT);
    assert.ok((decision?.reason ?? "").includes(past.path), decision?.reason ?? "no refusal");
  });
});

test("root-edit: a sh4dow session's write into a worktree is refused, by its relative path too", async () => {
  const call = session(rootArgv);
  const worktree = "/home/u/.pi/.worktrees/x";

  const [absolute, relative] = await Promise.all([
    call([sh4dowEntry], "/home/u/.pi", "write", inputOf("write", `${worktree}/a.md`)),
    call([sh4dowEntry], worktree, "edit", inputOf("edit", "agent/b.md")),
  ]);

  assert.match(absolute?.reason ?? "", ROOT_EDIT);
  assert.match(relative?.reason ?? "", ROOT_EDIT);
  assert.ok(
    (relative?.reason ?? "").includes(`${worktree}/agent/b.md`),
    relative?.reason ?? "no refusal",
  );
});

test("root-edit: a coordinator writes its state folder and temp files, and other sessions write anywhere", async () => {
  const root = session(rootArgv);
  const delegate = session(delegateArgv);
  const coordinator = [userMessage("# Implement a chunk\n\n#197")];
  const state = join(homedir(), ".local/state/pi-agent/pi-setup/implement-chunk/c");

  const allowed = await Promise.all([
    root(coordinator, "/home/u/p", "write", inputOf("write", `${state}/decisions.md`)),
    root(coordinator, state, "edit", inputOf("edit", "units.tsv")),
    root(
      [sh4dowEntry],
      "/home/u/p",
      "write",
      inputOf("write", "~/.local/state/pi-agent/p/c/plan.md"),
    ),
    root(coordinator, "/home/u/p", "write", inputOf("write", "/tmp/tmp.abc/notes.md")),
    root(coordinator, "/home/u/p", "write", inputOf("write", join(tmpdir(), "x", "probe.txt"))),
    root(coordinator, "/home/u/p", "bash", { command: "printf x > /tmp/tmp.abc/f" }),
    root(
      [userMessage("fix the typo in README.md")],
      "/home/u/p",
      "write",
      inputOf("write", "README.md"),
    ),
    delegate(coordinator, "/home/u/p", "write", inputOf("write", "/home/u/p/src/a.ts")),
  ]);

  assert.deepEqual(
    allowed,
    Array.from({ length: allowed.length }, () => undefined),
  );

  const escaped = await root(
    coordinator,
    state,
    "write",
    inputOf("write", "../../../../../../p/a.ts"),
  );

  assert.match(escaped?.reason ?? "", ROOT_EDIT, "a relative path that leaves the state folder");
});
