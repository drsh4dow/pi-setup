import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	Skill,
} from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem } from "effect";
import extension from "../index.ts";

const remove = (directory: string) =>
	Effect.runPromise(
		FileSystem.FileSystem.use((fs) =>
			fs.remove(directory, { recursive: true, force: true }),
		).pipe(Effect.provide(BunFileSystem.layer)),
	);

test("omits skills that users cannot invoke from the visibility picker", (t) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectory({
				directory: tmpdir(),
				prefix: "skill-visibility-test-",
			});
			t.after(() => remove(directory));

			const skills = [
				["automatic-only", "user-invokable: false\n"],
				["explicitly-visible", "user-invokable: true\n"],
				["visible-by-default", ""],
			] as const;
			yield* Effect.forEach(skills, ([name, visibility]) =>
				fs.writeFileString(
					`${directory}/${name}.md`,
					`---\nname: ${name}\ndescription: Test skill.\n${visibility}---\n`,
				),
			);

			let handler: RegisteredCommand["handler"] | undefined;
			extension({
				registerCommand(name: string, command: RegisteredCommand) {
					assert.equal(name, "skill-visibility");
					handler = command.handler;
				},
			} as unknown as ExtensionAPI);
			assert.ok(handler);
			const registeredHandler = handler;

			let choices: string[] = [];
			const loadedSkills = skills.map(([name]) => ({
				name,
				filePath: `${directory}/${name}.md`,
				disableModelInvocation: false,
			})) as Skill[];
			yield* Effect.promise(() =>
				registeredHandler("", {
					hasUI: true,
					getSystemPromptOptions: () => ({ skills: loadedSkills }),
					ui: {
						notify() {},
						select: (_title: string, options: string[]) => {
							choices = options;
							return Promise.resolve("Done");
						},
					},
				} as unknown as ExtensionCommandContext),
			);

			assert.deepEqual(choices, [
				"● explicitly-visible — discoverable",
				"● visible-by-default — discoverable",
				"Done",
			]);
		}).pipe(Effect.provide(BunFileSystem.layer)),
	));
