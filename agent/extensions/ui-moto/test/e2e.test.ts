import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { FileSystem, Layer, ManagedRuntime, Path, Schema } from "effect";
import {
	capture,
	e2eUnavailable,
	isDead,
	type PiSession,
	readStderr,
	runTask,
	sendKeys,
	startPi,
	stop,
	waitFor,
	waitForFile,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();
const runtime = ManagedRuntime.make(
	Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer),
);
const fs = runtime.runSync(FileSystem.FileSystem);
const path = runtime.runSync(Path.Path);
const Settings = Schema.fromJsonString(
	Schema.Struct({ defaultModel: Schema.String }),
);

const BAR_FILL = "─";

interface Header {
	/** The whole header row, full pane width. */
	readonly line: string;
	readonly modelId: string;
	readonly project: string;
	/** Bar fill to the left/right of the ` PI / … ` label. */
	readonly left: string;
	readonly right: string;
}

/** Parses the gradient header row out of a captured pane, if it is on screen. */
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

/** Model id pi's own footer reports, used as the source of truth for the header. */
function footerModelId(pane: string): string | undefined {
	return /\([\w-]+\)\s+(\S+)\s+•/.exec(pane)?.[1];
}

describe("ui-moto (real pi in tmux)", { skip }, () => {
	let session: PiSession;

	before(async () => {
		session = await startPi();
	});

	after(async () => {
		if (session) await stop(session);
	});

	test("paints a full-width header naming the model and the project", () => {
		assert.equal(isDead(session), false);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);

		const pane = capture(session);
		const bar = header(pane);
		assert.ok(bar, `no ui-moto header row in pane:\n${pane}`);

		assert.equal(
			bar.modelId,
			footerModelId(pane),
			`header model id disagrees with the footer:\n${pane}`,
		);
		assert.equal(bar.project, path.basename(session.cwd));

		// headerLine() centres ` PI / … ` in the available width, biasing the
		// remainder to the right.
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
	});

	test("surrounds the bar with the blank lines it renders", () => {
		const lines = capture(session).split("\n");
		const index = lines.findIndex((line) => line.includes(" PI / "));
		assert.ok(index > 0, "header row not found");
		assert.equal((lines[index - 1] ?? "").trim(), "");
		assert.equal((lines[index + 1] ?? "").trim(), "");
	});

	test("header follows model_select when the model is cycled", async () => {
		const first = header(capture(session));
		assert.ok(first, "header missing before cycling the model");

		await sendKeys(session, "M-p");
		// The header repaints on model_select ahead of pi's own footer, so wait for
		// the two to agree rather than sampling mid-switch.
		const cycled = await waitFor(
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
		const settings = Schema.decodeUnknownSync(Settings)(
			await runtime.runPromise(
				fs.readFileString(path.join(session.agentDir, "settings.json")),
			),
		);
		assert.equal(settings.defaultModel, second.modelId);

		// Put the session back on the model the rest of the file expects.
		await sendKeys(session, "M-p");
		await waitFor(
			session,
			(pane) =>
				header(pane)?.modelId === first.modelId &&
				footerModelId(pane) === first.modelId,
			{
				timeoutMs: 30_000,
				description: "header to return to the first model",
			},
		);
		assert.equal(isDead(session), false);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);
	});

	test("header survives a real task", async () => {
		const before = header(capture(session));
		assert.ok(before, "header missing before the task");

		await runTask(
			session,
			"Create a file named ui-moto-e2e.txt whose entire contents are exactly: ui-moto-ok",
			180_000,
		);
		assert.equal(
			(await waitForFile(session, "ui-moto-e2e.txt")).trim(),
			"ui-moto-ok",
		);

		assert.equal(isDead(session), false);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);

		const scrollback = capture(session, true);
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
