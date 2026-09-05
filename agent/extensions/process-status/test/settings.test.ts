import assert from "node:assert/strict";
import test from "node:test";
import {
	type ExtensionContext,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem } from "effect";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";
import extension from "../index.ts";

test("mounted footer observes persisted settings and stops observing on disposal", (t) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const root = yield* fs.makeTempDirectory({
				prefix: "pi-footer-settings-",
			});
			// The SDK resolves its settings directory from the process environment.
			// @effect-diagnostics-next-line processEnvInEffect:off
			const original = process.env.PI_CODING_AGENT_DIR;
			// @effect-diagnostics-next-line processEnvInEffect:off
			process.env.PI_CODING_AGENT_DIR = root;
			t.after(() => {
				// @effect-diagnostics-next-line processEnv:off
				if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
				// @effect-diagnostics-next-line processEnv:off
				else process.env.PI_CODING_AGENT_DIR = original;
				return Effect.runPromise(
					fs.remove(root, { recursive: true, force: true }),
				);
			});
			const globalPath = `${root}/settings.json`;
			const projectPath = `${root}/.pi/settings.json`;
			yield* fs.makeDirectory(`${root}/.pi`);
			yield* fs.writeFileString(globalPath, '{"compaction":{"enabled":true}}');
			let factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0];
			const adapter = extensionTestAdapter();
			const api = unsafeFixture<typeof adapter.api>({
				...adapter.api,
				registerTool() {},
				registerCommand() {},
				registerEntryRenderer() {},
				getThinkingLevel: () => "off",
				events: { emit() {} },
			});
			const context = unsafeFixture<ExtensionContext>({
				cwd: root,
				mode: "tui",
				isProjectTrusted: () => true,
				modelRegistry: {},
				getContextUsage: () => undefined,
				sessionManager: {
					getEntries: () => [],
					getCwd: () => root,
					getSessionName: () => undefined,
				},
				ui: {
					setFooter: (value: typeof factory) => {
						factory = value;
					},
				},
			});
			extension(api);
			yield* Effect.promise(() =>
				adapter.emit(
					"session_start",
					{ type: "session_start", reason: "startup" },
					context,
				),
			);
			assert.ok(factory);
			initTheme();
			let renders = 0;
			const footer = factory(
				unsafeFixture({
					requestRender: () => {
						renders++;
					},
				}),
				unsafeFixture({}),
				{
					getGitBranch: () => null,
					getExtensionStatuses: () => new Map(),
					getAvailableProviderCount: () => 1,
					onBranchChange: () => () => {},
				},
			);
			t.after(() => footer.dispose?.());
			assert.match(footer.render(100).join("\n"), /\(auto\)/);
			for (const [path, enabled] of [
				[globalPath, false],
				[globalPath, true],
				[projectPath, false],
			] as const) {
				const before = renders;
				yield* fs.writeFileString(
					path,
					enabled
						? '{"compaction":{"enabled":true}}'
						: '{"compaction":{"enabled":false}}',
				);
				yield* Effect.gen(function* () {
					while (renders === before) yield* Effect.sleep(25);
				}).pipe(Effect.timeout(3000));
				assert.equal(footer.render(100).join("\n").includes("(auto)"), enabled);
			}
			// An unrelated write under a held lock must not replace false with
			// the SDK's fallback true. Releasing the lock does not touch settings.
			yield* fs.makeDirectory(`${projectPath}.lock`);
			yield* fs.writeFileString(
				projectPath,
				'{"compaction":{"enabled":false},"quietStartup":true}',
			);
			yield* Effect.sleep(1000);
			assert.equal(footer.render(100).join("\n").includes("(auto)"), false);
			yield* fs.writeFileString(projectPath, '{"compaction":{"enabled":true}}');
			yield* Effect.sleep(1000);
			assert.equal(footer.render(100).join("\n").includes("(auto)"), false);
			yield* fs.remove(`${projectPath}.lock`, { recursive: true });
			yield* Effect.gen(function* () {
				while (!footer.render(100).join("\n").includes("(auto)"))
					yield* Effect.sleep(25);
			}).pipe(Effect.timeout(7000));
			footer.dispose?.();
			footer.dispose?.();
			const before = renders;
			yield* fs.writeFileString(projectPath, '{"compaction":{"enabled":true}}');
			yield* Effect.sleep(500);
			assert.equal(renders, before);
		}).pipe(Effect.provide(BunFileSystem.layer)),
	));
