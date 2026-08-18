import assert from "node:assert/strict";
import { describe } from "node:test";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import {
	capture,
	e2eUnavailable,
	isDead,
	type PiSession,
	readStderr,
	runTask,
	sendKeys,
	setupPiSession,
	testEffect,
	waitFor,
	waitForFile,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();
const { fs, path } = Effect.runSync(
	Effect.gen(function* () {
		return { fs: yield* FileSystem.FileSystem, path: yield* Path.Path };
	}).pipe(
		Effect.provide(
			Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer),
		),
	),
);
const Settings = Schema.fromJsonString(
	Schema.Struct({ defaultModel: Schema.String }),
);

const BAR_FILL = "─";

interface Header {
	readonly line: string;
	readonly modelId: string;
	readonly project: string;
	readonly left: string;
	readonly right: string;
}

function header(pane: string): Header | undefined {
	const lines = pane.split("\n");
	const index = lines.findIndex((line) => line.includes(" PI / "));
	if (index === -1) return undefined;

	const line = lines[index] ?? "";
	const match = /^(─*) PI \/ (\S+) \/ (\S+) (─*)$/.exec(line);
	if (!match) return undefined;

	return {
		line,
		left: match[1] ?? "",
		modelId: match[2] ?? "",
		project: match[3] ?? "",
		right: match[4] ?? "",
	};
}

function footerModelId(pane: string): string | undefined {
	return /\([\w-]+\)\s+(\S+)\s+•/.exec(pane)?.[1];
}

describe("ui-moto (real pi in tmux)", { skip }, () => {
	let session: PiSession;

	setupPiSession((value) => {
		session = value;
	});

	testEffect(
		"paints a full-width header naming the model and the project",
		function* () {
			assert.equal(yield* isDead(session), false);
			assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);

			const pane = yield* capture(session);
			const bar = header(pane);
			assert.ok(bar, `no ui-moto header row in pane:\n${pane}`);

			assert.equal(
				bar.modelId,
				footerModelId(pane),
				`header model id disagrees with the footer:\n${pane}`,
			);
			assert.equal(bar.project, path.basename(session.cwd));

			const label = ` PI / ${bar.modelId} / ${bar.project} `;
			assert.equal(bar.line, `${bar.left}${label}${bar.right}`);
			assert.ok(
				bar.line.length > label.length + 20,
				`header did not span the pane: ${bar.line.length} columns`,
			);
			assert.equal(
				bar.left.length,
				Math.floor((bar.line.length - label.length) / 2),
				`header label is not centred:\n${bar.line}`,
			);
			assert.equal(
				bar.right.length,
				bar.line.length - label.length - bar.left.length,
			);
			assert.equal(
				bar.left + bar.right,
				BAR_FILL.repeat(bar.left.length + bar.right.length),
			);
		},
	);

	testEffect("surrounds the bar with the blank lines it renders", function* () {
		const lines = (yield* capture(session)).split("\n");
		const index = lines.findIndex((line) => line.includes(" PI / "));
		assert.ok(index > 0, "header row not found");
		assert.equal((lines[index - 1] ?? "").trim(), "");
		assert.equal((lines[index + 1] ?? "").trim(), "");
	});

	testEffect(
		"header follows model_select when the model is cycled",
		function* () {
			const first = header(yield* capture(session));
			assert.ok(first, "header missing before cycling the model");

			yield* sendKeys(session, "M-p");
			const cycled = yield* waitFor(
				session,
				(pane) => {
					const bar = header(pane);
					return (
						bar !== undefined &&
						bar.modelId !== first.modelId &&
						footerModelId(pane) === bar.modelId
					);
				},
				{ timeoutMs: 30_000, description: "header to pick up the new model" },
			);
			const second = header(cycled);
			assert.ok(second, "header missing after cycling the model");
			assert.notEqual(second.modelId, first.modelId);
			assert.equal(second.project, first.project);
			assert.equal(second.line.length, first.line.length);
			const settings = yield* Schema.decodeEffect(Settings)(
				yield* fs.readFileString(path.join(session.agentDir, "settings.json")),
			);
			assert.equal(settings.defaultModel, second.modelId);

			yield* sendKeys(session, "M-p");
			yield* waitFor(
				session,
				(pane) =>
					header(pane)?.modelId === first.modelId &&
					footerModelId(pane) === first.modelId,
				{
					timeoutMs: 30_000,
					description: "header to return to the first model",
				},
			);
			assert.equal(yield* isDead(session), false);
			assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		},
	);

	testEffect("header survives a real task", function* () {
		const before = header(yield* capture(session));
		assert.ok(before, "header missing before the task");

		yield* runTask(
			session,
			"Create a file named ui-moto-e2e.txt whose entire contents are exactly: ui-moto-ok",
			180_000,
		);
		assert.equal(
			(yield* waitForFile(session, "ui-moto-e2e.txt")).trim(),
			"ui-moto-ok",
		);

		assert.equal(yield* isDead(session), false);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);

		const scrollback = yield* capture(session, true);
		const rows = scrollback
			.split("\n")
			.filter((line) => line.includes(" PI / "));
		assert.ok(rows.length > 0, `header gone after the task:\n${scrollback}`);
		for (const row of rows) {
			const bar = header(row);
			assert.ok(bar, `header row corrupted after the task: ${row}`);
			assert.equal(bar.project, before.project);
			assert.equal(bar.line.length, before.line.length);
		}
	});
});
