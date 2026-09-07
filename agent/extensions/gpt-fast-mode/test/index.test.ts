import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fastServiceTier, withFastServiceTier } from "../index.ts";

describe("gpt-fast-mode request mapping", () => {
	for (const [provider, tier] of [
		["openai", "fast"],
		["openai-codex", "priority"],
	]) {
		test(`uses ${tier} for ${provider} without mutating the payload`, () => {
			const model = { provider, id: "gpt-5.6-sol" };
			const payload = { model: model.id, input: "hello" };
			assert.equal(fastServiceTier(model), tier);
			assert.deepEqual(withFastServiceTier(model, payload), {
				...payload,
				service_tier: tier,
			});
			assert.deepEqual(payload, { model: model.id, input: "hello" });
		});
	}

	test("does not tag models outside Codex's Fast catalog", () => {
		const model = { provider: "openai-codex", id: "gpt-5.4-mini" };
		const payload = { model: model.id, input: "hello" };
		assert.equal(fastServiceTier(model), undefined);
		assert.equal(withFastServiceTier(model, payload), payload);
	});

	test("preserves requests for other models and non-object payloads", () => {
		const model = { provider: "openai", id: "gpt-5.6-sol" };
		for (const payload of [
			{ model: "gpt-5.5", input: "hello", service_tier: "auto" },
			{},
			[],
			null,
			undefined,
			"request",
			1,
		]) {
			assert.equal(withFastServiceTier(model, payload), payload);
		}
		const payload = { model: model.id };
		assert.equal(fastServiceTier(undefined), undefined);
		assert.equal(withFastServiceTier(undefined, payload), payload);
	});
});

test("/fast persists and announces toggles and only maps enabled requests", () => {
	const { spawnSync } = process.getBuiltinModule("node:child_process");
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "pi-fast-mode-"));
process.env.PI_CODING_AGENT_DIR = root;
try {
  const { default: extension } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
  let toggle;
  const handlers = new Map();
  extension({
    registerCommand(name, command) { assert.equal(name, "fast"); toggle = command.handler; },
    registerShortcut() {},
    on(name, handler) { handlers.set(name, handler); },
  });
  const notices = [];
  const ctx = {
    model: { provider: "openai", id: "gpt-5.6-sol" },
    ui: { notify(message, level) { notices.push([message, level]); } },
  };
  await handlers.get("session_start")({}, ctx);
  const payload = { model: ctx.model.id, input: "hello" };
  const request = () => handlers.get("before_provider_request")({ payload }, ctx);
  assert.equal(request(), undefined);
  await toggle("", ctx);
  assert.deepEqual(request(), { ...payload, service_tier: "fast" });
  assert.deepEqual(JSON.parse(readFileSync(join(root, "gpt-fast-mode.json"), "utf8")), { enabled: true });
  await toggle("", ctx);
  assert.equal(request(), undefined);
  ctx.model = undefined;
  await toggle("", ctx);
  assert.equal(request(), payload);
  rmSync(root, { recursive: true });
  await toggle("", ctx);
  assert.deepEqual(notices, [
    ["GPT Fast mode enabled (service_tier: fast).", "info"],
    ["GPT Fast mode disabled.", "info"],
    ["GPT Fast mode enabled, but unknown model is not supported.", "warning"],
    ["Could not save GPT Fast mode setting.", "error"],
  ]);
} finally {
  rmSync(root, { recursive: true, force: true });
}
`,
		],
		{ encoding: "utf8", timeout: 10_000 },
	);
	assert.equal(result.status, 0, result.stderr);
});
