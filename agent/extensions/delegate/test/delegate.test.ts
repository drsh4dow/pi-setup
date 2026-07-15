import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { delimiter } from "node:path";
import test from "node:test";
import {
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import delegateExtension, {
  childExtensionPaths,
  extractAssistantText,
  formatDelegateOutput,
  selectChildToolNames,
  thinkingForEffort,
} from "../index.ts";

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
