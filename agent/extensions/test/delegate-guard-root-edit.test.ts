import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createWriteTool,
  type ExtensionContext,
  stripFrontmatter,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

import delegateGuardExtension, { editTarget } from "../delegate-guard.ts";
import { SH4DOW_MODE_ENTRY } from "../sh4dow/index.ts";
import { extensionTestAdapter, unsafeFixture } from "./adapter.ts";
import { decodeDecision, delegateArgv, rootArgv } from "./guard-fixtures.ts";

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

type ToolInput = Record<string, string>;

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

const inputOf = (toolName: string, path: string): ToolInput =>
  toolName === "write" ? { path, content: "x" } : { path, oldText: "a", newText: "b" };

async function piWritePath(path: string, cwd: string): Promise<string | undefined> {
  let written: string | undefined;

  const tool = createWriteTool(cwd, {
    operations: {
      mkdir: async () => {},
      writeFile: async (absolutePath) => {
        written = absolutePath;
      },
    },
  });

  await tool.execute("probe", { path, content: "x" });

  return written;
}

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

test("root-edit: a session that ran the /implement-chunk prompt Pi loads is a coordinator", async () => {
  const prompt = new URL("../../prompts/implement-chunk.md", import.meta.url);
  const expanded = stripFrontmatter(readFileSync(prompt, "utf8")).replaceAll("$@", "#197");

  const decision = await session(rootArgv)(
    [userMessage(expanded)],
    "/home/u/p",
    "write",
    inputOf("write", "src/a.ts"),
  );

  assert.match(decision?.reason ?? "", ROOT_EDIT);
});

test("root-edit: a session that starts the implement-chunk prompt after a general task is a coordinator from then on", async () => {
  const call = session(rootArgv);
  const general = userMessage("fix the typo in README.md");

  const coordinator = userMessage(
    "# Implement a chunk\n\nSTOP: write later.md and call no other tool",
  );

  const [before, after, afterAnotherMessage] = await Promise.all([
    call([general], "/home/u/p", "write", inputOf("write", "later.md")),
    call([general, coordinator], "/home/u/p", "write", inputOf("write", "later.md")),
    call([general, coordinator, general], "/home/u/p", "edit", inputOf("edit", "later.md")),
  ]);

  assert.equal(before, undefined, "the general task alone writes code");
  assert.match(after?.reason ?? "", ROOT_EDIT);
  assert.match(afterAnotherMessage?.reason ?? "", ROOT_EDIT, "it stays a coordinator");
});

test("root-edit: a general task whose heading only begins with the prompt's heading writes code", async () => {
  const call = session(rootArgv);

  const [uploader, heading] = await Promise.all([
    call(
      [userMessage("# Implement a chunked uploader\nPlease write code.")],
      "/home/u/p",
      "write",
      inputOf("write", "uploader.md"),
    ),
    call([userMessage("# Implement a chunk")], "/home/u/p", "write", inputOf("write", "a.md")),
  ]);

  assert.equal(uploader, undefined);
  assert.match(heading?.reason ?? "", ROOT_EDIT, "the heading alone is the prompt");
});

test("root-edit: a coordinator's write through a temp link is judged by where it lands", async (t) => {
  const call = session(rootArgv);
  const coordinator = [userMessage("# Implement a chunk\n\n#197")];
  const scratch = mkdtempSync(join(tmpdir(), "root-edit-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  symlinkSync("/", join(scratch, "root-link"), "dir");
  symlinkSync("/root-edit-missing.ts", join(scratch, "dangling.ts"));

  const [throughLink, throughDanglingLink, scratchFile] = await Promise.all([
    call(coordinator, "/home/u/p", "write", inputOf("write", join(scratch, "root-link/u/a.ts"))),
    call(coordinator, "/home/u/p", "write", inputOf("write", join(scratch, "dangling.ts"))),
    call(coordinator, "/home/u/p", "write", inputOf("write", join(scratch, "notes/a.md"))),
  ]);

  assert.match(throughLink?.reason ?? "", ROOT_EDIT, "a temp link into code");
  assert.match(throughLink?.reason ?? "", /\s\/u\/a\.ts\b/, "the refusal names where it lands");
  assert.match(throughDanglingLink?.reason ?? "", ROOT_EDIT, "a temp link to a missing code file");
  assert.equal(scratchFile, undefined, "a new file in the same temp directory");
});

test("root-edit: a no-break space in a temp path is read as Pi's tools read it, as a space", async (t) => {
  const call = session(rootArgv);
  const coordinator = [userMessage("# Implement a chunk\n\n#197")];
  const scratch = mkdtempSync(join(tmpdir(), "root-edit-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  symlinkSync("/", join(scratch, "space link"), "dir");
  const intoCode = join(scratch, "space\u00A0link", "u", "a.ts");

  assert.equal(await piWritePath(intoCode, "/home/u/p"), join(scratch, "space link", "u", "a.ts"));
  assert.equal(realpathSync(join(scratch, "space link")), "/", "Pi's write lands in code");

  const refusal = await call(coordinator, "/home/u/p", "write", inputOf("write", intoCode));

  assert.match(refusal?.reason ?? "", ROOT_EDIT, "a write that lands in code");
});

test("root-edit: a no-break-space link into code does not refuse the temp write Pi makes beside it", async (t) => {
  const call = session(rootArgv);
  const coordinator = [userMessage("# Implement a chunk\n\n#197")];
  const scratch = mkdtempSync(join(tmpdir(), "root-edit-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  symlinkSync("/", join(scratch, "unicode\u00A0link"), "dir");
  mkdirSync(join(scratch, "unicode link"));
  const named = join(scratch, "unicode\u00A0link", "a.txt");

  const decision = await call(coordinator, "/home/u/p", "write", inputOf("write", named));

  await createWriteTool("/home/u/p").execute("probe", { path: named, content: "temp" });

  assert.equal(readFileSync(join(scratch, "unicode link", "a.txt"), "utf8"), "temp");
  assert.equal(decision, undefined, "Pi's write lands in the temp directory");
});

const UNICODE_SPACES = [
  0xa0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x202f, 0x205f, 0x3000,
].map((code) => String.fromCodePoint(code));

test("root-edit: the guard judges every path at the file Pi's write tool writes", async () => {
  const cwd = "/home/u/p";
  const nbsp = "\u00A0";

  const paths = [
    ...UNICODE_SPACES.flatMap((space) => [`a${space}b/c.ts`, `/tmp/x${space}y/c.ts`]),
    "src/a.ts",
    "./src/../b.ts",
    "../q/a.ts",
    "/home/u/p/a.ts",
    "@src/a.ts",
    "@/tmp/a.ts",
    "@@a.ts",
    `${nbsp}@a.ts`,
    `@${nbsp}a.ts`,
    "~",
    "~/a.ts",
    "@~/a.ts",
    `~${nbsp}/a.ts`,
    `~/a${nbsp}b.ts`,
    "~user/a.ts",
    "file:///home/u/p/a.ts",
    "@file:///tmp/a.ts",
    "file:///tmp/a%20b.ts",
    `file:///tmp/a${nbsp}b.ts`,
    `file:///tmp/a%C2%A0b.ts`,
  ];

  const written = await Promise.all(paths.map((path) => piWritePath(path, cwd)));

  assert.deepEqual(
    paths.map((path) => [path, editTarget(path, cwd)]),
    paths.map((path, index) => [path, written[index]]),
  );
});

test("root-edit: a temp child whose name starts with two dots is inside the temp directory", async () => {
  const call = session(rootArgv);
  const coordinator = [userMessage("# Implement a chunk\n\n#197")];

  const [dotDotName, parent] = await Promise.all([
    call(coordinator, "/home/u/p", "write", inputOf("write", "/tmp/..notes/file.md")),
    call(coordinator, "/tmp/x", "write", inputOf("write", "../../home/u/p/a.ts")),
  ]);

  assert.equal(dotDotName, undefined);
  assert.match(parent?.reason ?? "", ROOT_EDIT, "a real parent segment still leaves it");
});

test("root-edit: a coordinator's file URL is judged by the path Pi's tools write", async () => {
  const call = session(rootArgv);
  const state = join(homedir(), ".local/state/pi-agent/p/c");

  const refusal = await call(
    [userMessage("# Implement a chunk\n\n#197")],
    state,
    "write",
    inputOf("write", "file:///home/u/p/a.ts"),
  );

  assert.match(refusal?.reason ?? "", ROOT_EDIT);
});
