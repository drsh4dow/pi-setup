import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxProvider, type SystemMessage } from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  type ExtensionUIContext,
  type FileEntry,
  parseSessionEntries,
  type SessionHeader,
  initTheme,
  SessionManager,
  SessionSelectorComponent,
  SettingsManager,
  TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import promptContext from "../../prompt-context/index.ts";
import { unsafeFixture } from "../../test/adapter.ts";
import sh4dow, { createSh4dowExtension, SH4DOW_MODE_ENTRY, SH4DOW_PROMPT } from "../index.ts";

const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
  process.getBuiltinModule("fs");

const { join } = process.getBuiltinModule("path");

const agentSource = new URL("../../../", import.meta.url);

const GENERAL_PROMPT = readFileSync(new URL("SYSTEM.md", agentSource), "utf8");

const SH4DOW_PROMPT_TEXT = readFileSync(new URL(SH4DOW_PROMPT, agentSource), "utf8");

type Sections = NonNullable<SystemMessage["sections"]>;

interface Pi {
  readonly runtime: AgentSessionRuntime;
  readonly notices: string[];
  type(text: string): Promise<void>;
  file(): string;
}

interface Home {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
}

function home(t: TestContext): Home {
  const directory = mkdtempSync(join(tmpdir(), "pi-sh4dow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  const cwd = join(directory, "project");
  const sessionDir = join(directory, "sessions");
  mkdirSync(join(agentDir, "skills", "sample"), { recursive: true });
  mkdirSync(cwd);
  mkdirSync(sessionDir);
  writeFileSync(join(agentDir, "SYSTEM.md"), GENERAL_PROMPT);
  writeFileSync(
    join(agentDir, "skills", "sample", "SKILL.md"),
    "---\nname: sample\ndescription: SAMPLE SKILL DESCRIPTION\n---\nInspect the sample.\n",
  );

  return { cwd, agentDir, sessionDir };
}

async function launch(
  t: TestContext,
  { cwd, agentDir, sessionDir }: Home,
  { session, extension = sh4dow }: { session?: string; extension?: ExtensionFactory } = {},
): Promise<Pi> {
  const provider = fauxProvider();
  provider.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("ok")));
  const notices: string[] = [];

  const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({
        defaultProjectTrust: "always",
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      resourceLoaderOptions: { extensionFactories: [promptContext, extension] },
    });

    services.modelRuntime.registerNativeProvider(provider.provider);

    const created = await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent,
      model: provider.getModel(),
      thinkingLevel: "off",
    });

    return { ...created, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: session
      ? SessionManager.open(session, sessionDir)
      : SessionManager.create(cwd, sessionDir),
  });

  t.after(() => runtime.dispose());

  const bind = () =>
    runtime.session.bindExtensions({
      mode: "print",
      uiContext: unsafeFixture<ExtensionUIContext>({
        notify: (message: string) => {
          notices.push(message);
        },
      }),
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        fork: (entryId, options) => runtime.fork(entryId, options),
        navigateTree: (targetId, options) => runtime.session.navigateTree(targetId, options),
        switchSession: (path, options) => runtime.switchSession(path, options),
        reload: () => runtime.session.reload(),
      },
      onError: (error) => assert.fail(error.error),
    });

  runtime.setRebindSession(bind);
  await bind();

  return {
    runtime,
    notices,
    async type(text) {
      await runtime.session.prompt(text);
      await runtime.session.waitForIdle();
    },
    file() {
      const file = runtime.session.sessionFile;
      assert.ok(file, "the session must be file-backed");

      return file;
    },
  };
}

function entries(file: string): FileEntry[] {
  return parseSessionEntries(readFileSync(file, "utf8"));
}

function header(file: string): SessionHeader {
  const [first] = entries(file);
  assert.ok(first?.type === "session", "the file opens with its session header");

  return first;
}

// Each system message the session file records, in order; a later one patches the sections of
// the one before it by name.
function systemMessages(file: string): Sections[] {
  return entries(file).flatMap((entry) =>
    entry.type === "message" && entry.message.role === "system"
      ? [entry.message.sections ?? {}]
      : [],
  );
}

function recordedPrompt(file: string): ReadonlyMap<string, string> {
  const prompt = new Map<string, string>();

  for (const patch of systemMessages(file)) {
    for (const [name, value] of Object.entries(patch)) {
      if (value === null) prompt.delete(name);
      else prompt.set(name, value);
    }
  }

  return prompt;
}

function userTexts(file: string): string[] {
  return entries(file).flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const { content } = entry.message;

    return Array.isArray(content)
      ? [content.map((part) => (part.type === "text" ? part.text : "")).join("")]
      : [content];
  });
}

function head(preamble: string | null | undefined): string {
  return JSON.stringify(preamble?.split("\n").slice(0, 4).join("\n"));
}

function assertSh4dowPrompt(file: string) {
  const prompt = recordedPrompt(file);
  assert.ok(
    prompt.get("preamble") === SH4DOW_PROMPT_TEXT,
    `preamble is not the sh4dow prompt: ${head(prompt.get("preamble"))}`,
  );
  assert.equal(prompt.has("skills"), false, "no skill table");
  assert.ok(prompt.get("tools")?.includes("- read:"), "the tools section stays");
  assert.ok(prompt.get("rules"), "the rules section stays");

  for (const patch of systemMessages(file)) {
    if ("preamble" in patch) assert.ok(patch.preamble === SH4DOW_PROMPT_TEXT, head(patch.preamble));
    assert.ok(!patch.skills, "a run recorded a skill table");
  }
}

function assertGeneralPrompt(file: string) {
  const prompt = recordedPrompt(file);
  assert.ok(
    prompt.get("preamble") === GENERAL_PROMPT,
    `preamble is not the general prompt: ${head(prompt.get("preamble"))}`,
  );
  assert.ok(prompt.get("skills")?.includes("SAMPLE SKILL DESCRIPTION"), "the skill table stays");

  for (const patch of systemMessages(file)) {
    assert.ok(patch.preamble !== SH4DOW_PROMPT_TEXT, "a run recorded the sh4dow prompt");
  }
}

test("/sh4dow in a session with history opens a linked session that runs the coordinator", async (t) => {
  const pi = await launch(t, home(t));
  await pi.type("hello");
  const parent = pi.file();
  assert.ok(existsSync(parent), "the parent session reached disk");

  await pi.type("/sh4dow drsh4dow/implement-chunk-fixture#1 main staging");
  const child = pi.file();

  assert.notEqual(child, parent);
  assert.equal(header(child).parentSession, parent);
  const recorded = entries(child).slice(1);
  assert.deepEqual(
    recorded.flatMap((entry) => (entry.type === "custom" ? [[entry.customType, entry.data]] : [])),
    [[SH4DOW_MODE_ENTRY, { version: 1 }]],
  );
  assert.ok(
    recorded.findIndex((entry) => entry.type === "custom") <
      recorded.findIndex((entry) => entry.type === "message" && entry.message.role === "user"),
    "the mode entry comes before the first message",
  );
  assert.deepEqual(userTexts(child), [
    "The chunk: drsh4dow/implement-chunk-fixture#1 main staging",
  ]);
  assertSh4dowPrompt(child);
  assertGeneralPrompt(parent);
  assert.deepEqual(userTexts(parent), ["hello"]);
});

test("a sh4dow session keeps its prompt on a later run, after /reload, and on a resume", async (t) => {
  const where = home(t);
  const pi = await launch(t, where);
  await pi.type("hello");
  await pi.type("/sh4dow owner/repo#7");
  const child = pi.file();

  await pi.type("next step");
  assertSh4dowPrompt(child);

  // The TUI's /reload calls session.reload(), which reloads every extension.
  await pi.runtime.session.reload();
  await pi.type("after reload");
  assertSh4dowPrompt(child);

  const resumed = await launch(t, where, { session: child });
  await resumed.type("after resume");
  assert.equal(resumed.file(), child);
  assertSh4dowPrompt(child);
  assert.deepEqual(userTexts(child), [
    "The chunk: owner/repo#7",
    "next step",
    "after reload",
    "after resume",
  ]);
});

test("/new from a sh4dow session opens a general session", async (t) => {
  const pi = await launch(t, home(t));
  await pi.type("hello");
  await pi.type("/sh4dow owner/repo#7");
  const child = pi.file();

  await pi.runtime.newSession();
  await pi.type("fresh question");
  const fresh = pi.file();

  assert.notEqual(fresh, child);
  assert.equal(header(fresh).parentSession, undefined);
  assertGeneralPrompt(fresh);
});

test("/sh4dow inside a sh4dow session is refused and opens nothing", async (t) => {
  const pi = await launch(t, home(t));
  await pi.type("hello");
  await pi.type("/sh4dow owner/repo#7");
  const child = pi.file();
  const before = readFileSync(child, "utf8");

  await pi.type("/sh4dow owner/repo#8");

  assert.equal(pi.file(), child);
  assert.ok(readFileSync(child, "utf8") === before, "the sh4dow session file changed");
  assert.match(pi.notices.join("\n"), /already runs in sh4dow mode/);
});

test("/sh4dow without a ticket reference prints its usage and opens nothing", async (t) => {
  const pi = await launch(t, home(t));
  await pi.type("hello");
  const parent = pi.file();

  await pi.type("/sh4dow   ");

  assert.equal(pi.file(), parent);
  assert.match(
    pi.notices.join("\n"),
    /Usage: \/sh4dow <ticket reference> \[base branch\] \[target environment\]/,
  );
});

test("/sh4dow as the first message of a brand-new session names a parent file that never reached disk", async (t) => {
  const where = home(t);
  const pi = await launch(t, where);
  const unwritten = pi.file();

  await pi.type("/sh4dow owner/repo#7");
  const child = pi.file();

  // The header still names the session /sh4dow was typed in, but Pi writes a session file only
  // once it holds a reply, so that file does not exist.
  assert.equal(header(child).parentSession, unwritten);
  assert.equal(existsSync(unwritten), false);
  assertSh4dowPrompt(child);

  // /resume lists the sh4dow session alone. Its parent is not in the list, so the threaded view
  // shows it as a top-level session instead of nesting it under a parent.
  const listed = await SessionManager.list(where.cwd, where.sessionDir);
  assert.deepEqual(
    listed.map((session) => [session.path, session.parentSessionPath]),
    [[child, unwritten]],
  );

  const resumed = await launch(t, where, { session: child });
  await resumed.type("after resume");
  assertSh4dowPrompt(child);
});

function ignore(): void {}

/** The threaded /resume view of a home's sessions, as Pi renders it, without colors. */
function resumeView({ cwd, sessionDir }: Home): Promise<string[]> {
  initTheme("dark", false);

  const load = () => SessionManager.list(cwd, sessionDir);
  const listed = Promise.withResolvers<string[]>();
  let selector: SessionSelectorComponent | undefined = undefined;

  const rendered = () => {
    const lines = (selector?.getSessionList().render(160) ?? []).map((line) =>
      stripVTControlCharacters(line),
    );

    if (lines.some((line) => line.includes("The chunk:"))) listed.resolve(lines);
  };

  selector = new SessionSelectorComponent(load, load, ignore, ignore, ignore, rendered);

  const timer = setTimeout(
    () => listed.reject(new Error("the /resume view listed no session within 5 s")),
    5_000,
  );

  return listed.promise.finally(() => clearTimeout(timer));
}

/** The session tree /tree shows for a session file, as Pi renders it, without colors. */
function treeView(file: string, sessionDir: string): string[] {
  const manager = SessionManager.open(file, sessionDir);

  const selector = new TreeSelectorComponent(
    manager.getTree(),
    manager.getLeafId(),
    40,
    ignore,
    ignore,
  );

  return selector.render(160).map((line) => stripVTControlCharacters(line));
}

test("the /resume and /tree views show a brand-new /sh4dow session at the top, a linked one under its parent", async (t) => {
  const where = home(t);
  const pi = await launch(t, where);
  await pi.type("hello");
  await pi.type("/sh4dow owner/repo#7");

  const fresh = await launch(t, where);
  await fresh.type("/sh4dow owner/repo#8");
  const brandNew = fresh.file();

  const rows = await resumeView(where);
  const row = (text: string) => rows.find((line) => line.includes(text)) ?? "";

  assert.match(row("The chunk: owner/repo#7"), /└─ The chunk: owner\/repo#7/, rows.join("\n"));
  assert.match(row("The chunk: owner/repo#8"), /^\S* *The chunk: owner\/repo#8/, rows.join("\n"));
  assert.doesNotMatch(row("The chunk: owner/repo#8"), /[└├]─/, rows.join("\n"));

  const tree = treeView(brandNew, where.sessionDir).join("\n");

  assert.match(tree, /• \[system\]\n *• user: The chunk: owner\/repo#8\n/, tree);
  assert.doesNotMatch(tree, /hello/, tree);
});

test("a missing sh4dow prompt refuses /sh4dow and keeps a sh4dow session off the general prompt", async (t) => {
  const where = home(t);
  const pi = await launch(t, where);
  await pi.type("hello");
  await pi.type("/sh4dow owner/repo#7");
  const child = pi.file();

  const missing = join(where.agentDir, "missing", "sh4dow.md");
  const broken = await launch(t, where, { extension: createSh4dowExtension(missing) });
  await broken.type("hello");
  const parent = broken.file();
  await broken.type("/sh4dow owner/repo#8");

  assert.equal(broken.file(), parent);
  assert.ok(
    broken.notices.some((notice) => notice.includes(missing)),
    broken.notices.join("\n"),
  );

  const resumed = await launch(t, where, {
    session: child,
    extension: createSh4dowExtension(missing),
  });

  await resumed.type("after resume");
  const prompt = recordedPrompt(child);
  assert.ok(prompt.get("preamble") !== GENERAL_PROMPT, "the run fell back to the general prompt");
  assert.ok(
    prompt.get("preamble")?.includes(missing),
    "the run says which prompt it failed to read",
  );
  assert.equal(prompt.has("skills"), false);
});
