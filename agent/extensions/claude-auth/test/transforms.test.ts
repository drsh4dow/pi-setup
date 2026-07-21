import assert from "node:assert/strict";
import { test } from "node:test";
import { injectBillingHeader } from "../transforms.ts";

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function claudePayload() {
  return {
    model: "claude-haiku-4-5",
    system: [{ type: "text", text: IDENTITY }],
    messages: [{ role: "user", content: "hello world" }],
  };
}

test("injectBillingHeader: prepends billing block when identity present", () => {
  const payload = claudePayload();
  const out = injectBillingHeader(payload);
  assert.ok(out);
  const system = out.system as Array<{ text: string }>;
  assert.equal(system.length, 2);
  assert.match(system[0].text, /^x-anthropic-billing-header:/);
  assert.equal(system[1].text, IDENTITY);
});

test("injectBillingHeader: undefined without the identity block", () => {
  const payload = {
    model: "claude-haiku-4-5",
    system: [{ type: "text", text: "some other system prompt" }],
    messages: [{ role: "user", content: "hi" }],
  };
  assert.equal(injectBillingHeader(payload), undefined);
});

test("injectBillingHeader: undefined for non-Claude models", () => {
  const payload = {
    model: "gpt-4o",
    system: [{ type: "text", text: IDENTITY }],
    messages: [{ role: "user", content: "hi" }],
  };
  assert.equal(injectBillingHeader(payload), undefined);
});

test("injectBillingHeader: idempotent when already injected", () => {
  const payload = claudePayload();
  const first = injectBillingHeader(payload);
  assert.ok(first);
  // Second pass over the already-injected payload is a no-op.
  assert.equal(injectBillingHeader(first), undefined);
});

test("injectBillingHeader: undefined for non-object payloads", () => {
  assert.equal(injectBillingHeader(null), undefined);
  assert.equal(injectBillingHeader("string"), undefined);
  assert.equal(injectBillingHeader(42), undefined);
});

test("injectBillingHeader: undefined when messages are missing", () => {
  const payload = {
    model: "claude-haiku-4-5",
    system: [{ type: "text", text: IDENTITY }],
  };
  assert.equal(injectBillingHeader(payload), undefined);
});

test("injectBillingHeader: relocates non-core system entries to first user message", () => {
  const payload = {
    model: "claude-sonnet-4-6",
    system: [
      { type: "text", text: IDENTITY },
      { type: "text", text: "You are a helpful coding agent." },
      { type: "text", text: "Always respond in English." },
    ],
    messages: [{ role: "user", content: "hello" }],
  };
  const out = injectBillingHeader(payload);
  assert.ok(out);
  const system = out.system as Array<{ text: string }>;
  // Only billing header + identity should remain in system[]
  assert.equal(system.length, 2);
  assert.match(system[0].text, /^x-anthropic-billing-header:/);
  assert.equal(system[1].text, IDENTITY);
  // Non-core entries should be prepended to first user message
  const msgs = out.messages as Array<{ role: string; content: string }>;
  assert.ok(msgs[0].content.includes("You are a helpful coding agent."));
  assert.ok(msgs[0].content.includes("Always respond in English."));
  assert.ok(msgs[0].content.includes("hello"));
});
