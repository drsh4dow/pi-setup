import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
	ConfigProvider,
	Effect,
	FileSystem,
	Layer,
	Path,
	Schema,
} from "effect";
import {
	fastServiceTier,
	loadShortcuts,
	withFastServiceTier,
} from "../index.ts";

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

	test("uses priority for a labeled Codex account", () => {
		assert.equal(
			fastServiceTier({ provider: "openai-codex@work", id: "gpt-5.6-sol" }),
			"priority",
		);
	});

	test("uses priority for Codex gpt-6-astra", () => {
		const model = { provider: "openai-codex", id: "gpt-6-astra" };
		assert.equal(fastServiceTier(model), "priority");
		assert.deepEqual(withFastServiceTier(model, { model: model.id }), {
			model: model.id,
			service_tier: "priority",
		});
	});

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

test("loads shortcut settings, filtering invalid entries and preserving disable settings", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const directory = yield* fs.makeTempDirectoryScoped({
				prefix: "pi-fast-shortcuts-",
			});

			const load = loadShortcuts().pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({ PI_CODING_AGENT_DIR: directory }),
				),
			);

			assert.deepEqual(yield* load, ["ctrl+alt+m"]);

			for (const [setting, expected] of [
				[false, []],
				[null, []],
				[" ctrl+shift+f ", ["ctrl+shift+f"]],
				[[1, null, {}, "", "enter", "CTRL+M", " ctrl+alt+f "], ["ctrl+alt+f"]],
				[["return", " "], ["ctrl+alt+m"]],
				[42, ["ctrl+alt+m"]],
			]) {
				yield* fs.writeFileString(
					path.join(directory, "keybindings.json"),
					yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
						"pi-gpt-fast-mode": setting,
					}),
				);
				assert.deepEqual(yield* load, expected);
			}

			yield* fs.writeFileString(
				path.join(directory, "keybindings.json"),
				"invalid json",
			);
			assert.deepEqual(yield* load, ["ctrl+alt+m"]);
		}).pipe(
			Effect.scoped,
			Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
		),
	));

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
