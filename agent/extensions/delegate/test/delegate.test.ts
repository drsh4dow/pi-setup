import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import delegateExtension, {
  childExtensionPaths,
  extractAssistantText,
  formatDelegateOutput,
  readDelegateModelSetting,
  resolveDelegateModel,
  selectChildToolNames,
  thinkingForEffort,
} from "../index.ts";

type ResolveContext = Parameters<typeof resolveDelegateModel>[0];
type RegistryModel = NonNullable<ResolveContext["model"]>;

const parentModel = { provider: "anthropic", id: "parent" } as RegistryModel;
const configuredModel = { provider: "opencode", id: "fable" } as RegistryModel;
const settingsDir = mkdtempSync(join(tmpdir(), "pi-delegate-test-"));
let settingsNumber = 0;

test.after(() => rmSync(settingsDir, { recursive: true, force: true }));

function fakeContext(options?: {
  parent?: boolean;
  auth?: boolean;
}): ResolveContext {
  return {
    model: (options?.parent ?? true) ? parentModel : undefined,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "opencode" && id === "fable" ? configuredModel : undefined,
      hasConfiguredAuth: () => options?.auth ?? true,
    } as ResolveContext["modelRegistry"],
  };
}

function settingsFile(content: string): string {
  const path = join(settingsDir, `settings-${settingsNumber++}.json`);
  writeFileSync(path, content, "utf8");
  return path;
}

test("reads the delegate model from settings.json", () => {
  assert.deepEqual(
    readDelegateModelSetting(
      settingsFile('{"delegate": {"model": " opencode/fable "}}'),
    ),
    { model: "opencode/fable" },
  );
  assert.deepEqual(
    readDelegateModelSetting(settingsFile('{"theme": "dark"}')),
    {},
  );
  assert.deepEqual(
    readDelegateModelSetting(join(tmpdir(), "pi-delegate-test-missing.json")),
    {},
  );
});

test("reports malformed delegate settings as problems, not failures", () => {
  assert.match(
    readDelegateModelSetting(settingsDir).problem ?? "",
    /Could not read/,
  );
  assert.match(
    readDelegateModelSetting(settingsFile("{not json")).problem ?? "",
    /Could not parse/,
  );
  assert.match(
    readDelegateModelSetting(settingsFile('{"delegate": true}')).problem ?? "",
    /must be an object/,
  );
  assert.match(
    readDelegateModelSetting(settingsFile('{"delegate": {"model": 42}}'))
      .problem ?? "",
    /must be a "provider\/model-id" string/,
  );
});

test("uses the configured delegate model when available", () => {
  const choice = resolveDelegateModel(fakeContext(), {
    model: "opencode/fable",
  });
  assert.equal(choice.model, configuredModel);
  assert.equal(choice.requestedModel, "opencode/fable");
  assert.equal(choice.fallbackReason, undefined);
});

test("falls back to the parent model when the configured model is unusable", () => {
  const missing = resolveDelegateModel(fakeContext(), {
    model: "opencode/unknown",
  });
  assert.equal(missing.model, parentModel);
  assert.equal(missing.requestedModel, "opencode/unknown");
  assert.match(missing.fallbackReason ?? "", /not found in the model registry/);

  const unauthenticated = resolveDelegateModel(fakeContext({ auth: false }), {
    model: "opencode/fable",
  });
  assert.equal(unauthenticated.model, parentModel);
  assert.match(unauthenticated.fallbackReason ?? "", /no auth configured/);

  const malformed = resolveDelegateModel(fakeContext(), { model: "fable" });
  assert.equal(malformed.model, parentModel);
  assert.match(
    malformed.fallbackReason ?? "",
    /must be a "provider\/model-id" string/,
  );
});

test("defaults to the parent model without a configured delegate model", () => {
  assert.deepEqual(resolveDelegateModel(fakeContext(), {}), {
    model: parentModel,
    requestedModel: "parent model",
    fallbackReason: undefined,
  });

  const orphan = resolveDelegateModel(fakeContext({ parent: false }), {
    problem: "Could not parse settings.json.",
  });
  assert.equal(orphan.model, undefined);
  assert.equal(
    orphan.fallbackReason,
    "Could not parse settings.json. No parent model was available; Pi will use its normal session default.",
  );

  const parentFallback = resolveDelegateModel(fakeContext(), {
    problem: "Could not parse settings.json.",
  });
  assert.equal(
    parentFallback.fallbackReason,
    "Could not parse settings.json. Using the parent model instead.",
  );
});

test("registers the parallel delegate tool", () => {
  let tool:
    | {
        name: string;
        executionMode?: "sequential" | "parallel";
        execute: unknown;
        renderCall?: unknown;
        renderResult?: unknown;
      }
    | undefined;
  delegateExtension({
    registerTool(registered) {
      tool = registered;
    },
  } as ExtensionAPI);

  assert.equal(tool?.name, "delegate");
  assert.equal(tool?.executionMode, "parallel");
  assert.equal(typeof tool?.execute, "function");
  assert.equal(typeof tool?.renderCall, "function");
  assert.equal(typeof tool?.renderResult, "function");
});

test("maps effort to the child thinking level", () => {
  assert.equal(thinkingForEffort("fast"), "low");
  assert.equal(thinkingForEffort("thorough"), "high");
});

test("keeps child tools unique and prevents recursive delegation", () => {
  assert.deepEqual(
    selectChildToolNames([
      { name: "read" },
      { name: "delegate" },
      { name: "read" },
      { name: "bash" },
      { name: "subagent" },
    ]),
    ["read", "bash"],
  );
});

test("normalizes configured child extension paths", () => {
  assert.deepEqual(
    childExtensionPaths({
      PI_CHILD_EXTENSION_PATHS: [" /one ", "", "/two", "/one"].join(delimiter),
    }),
    ["/one", "/two"],
  );
});

test("extracts only assistant text blocks", () => {
  assert.equal(
    extractAssistantText({
      role: "assistant",
      content: [
        { type: "text", text: " first " },
        { type: "toolCall", name: "read" },
        { type: "text", text: "second" },
      ],
    }),
    "first\nsecond",
  );
  assert.equal(extractAssistantText({ role: "user", content: "ignored" }), "");
});

test("leaves output below the truncation limit unchanged", async () => {
  assert.deepEqual(await formatDelegateOutput("child report"), {
    text: "child report",
  });
});

test("saves the complete report when output is truncated", async () => {
  const report = Array.from(
    { length: DEFAULT_MAX_LINES + 1 },
    (_, index) => `line ${index}`,
  ).join("\n");
  const output = await formatDelegateOutput(report);

  assert.equal(output.truncation?.truncated, true);
  assert.ok(output.fullOutputFile);
  try {
    assert.equal(await readFile(output.fullOutputFile, "utf8"), report);
  } finally {
    await unlink(output.fullOutputFile);
  }
});
