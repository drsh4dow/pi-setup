import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	Skill,
} from "@earendil-works/pi-coding-agent";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { FileSystem, Layer, ManagedRuntime, Path } from "effect";
import extension from "../index.ts";

test("omits skills that users cannot invoke from the visibility picker", async (t) => {
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer),
	);
	const fs = runtime.runSync(FileSystem.FileSystem);
	const path = runtime.runSync(Path.Path);
	const directory = await runtime.runPromise(
		fs.makeTempDirectory({
			directory: tmpdir(),
			prefix: "skill-visibility-test-",
		}),
	);
	t.after(async () => {
		await runtime.runPromise(
			fs.remove(directory, { recursive: true, force: true }),
		);
		await runtime.dispose();
	});

	const skills = [
		["automatic-only", "user-invokable: false\n"],
		["explicitly-visible", "user-invokable: true\n"],
		["visible-by-default", ""],
	] as const;
	await Promise.all(
		skills.map(async ([name, visibility]) => {
			const filePath = path.join(directory, `${name}.md`);
			await runtime.runPromise(
				fs.writeFileString(
					filePath,
					`---\nname: ${name}\ndescription: Test skill.\n${visibility}---\n`,
				),
			);
		}),
	);

	let handler: RegisteredCommand["handler"] | undefined;
	extension({
		registerCommand(name: string, command: RegisteredCommand) {
			assert.equal(name, "skill-visibility");
			handler = command.handler;
		},
	} as unknown as ExtensionAPI);
	assert.ok(handler);

	let choices: string[] = [];
	const loadedSkills = skills.map(([name]) => ({
		name,
		filePath: path.join(directory, `${name}.md`),
		disableModelInvocation: false,
	})) as Skill[];
	await handler("", {
		hasUI: true,
		getSystemPromptOptions: () => ({ skills: loadedSkills }),
		ui: {
			notify() {},
			select: async (_title: string, options: string[]) => {
				choices = options;
				return "Done";
			},
		},
	} as unknown as ExtensionCommandContext);

	assert.deepEqual(choices, [
		"● explicitly-visible — discoverable",
		"● visible-by-default — discoverable",
		"Done",
	]);
});
