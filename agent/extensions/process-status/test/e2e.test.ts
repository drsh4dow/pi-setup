import assert from "node:assert/strict";
import { describe } from "node:test";
import {
	capture,
	e2eUnavailable,
	isDead,
	type PiSession,
	prompt,
	readStderr,
	runTask,
	sendKeys,
	setupPiSession,
	testEffect,
	waitFor,
	waitForFile,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();

describe("process-status (real pi in tmux)", { skip }, () => {
	let session: PiSession;

	setupPiSession((value) => {
		session = value;
	});

	testEffect("boots the replacement footer without crashing", function* () {
		assert.equal(yield* isDead(session), false);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		const pane = yield* capture(session);
		assert.match(pane, /%\/\d/, `footer context gauge missing:\n${pane}`);
	});

	testEffect("/ps reports an idle process list", function* () {
		yield* prompt(session, "/ps");
		const pane = yield* waitFor(session, /\[ps\]/, {
			description: "/ps entry",
		});
		assert.match(pane, /\[ps\].*idle/);
	});

	testEffect("Ctrl+O keeps the expanded /ps entry renderable", function* () {
		yield* sendKeys(session, "C-o");
		const pane = yield* waitFor(session, /\[ps\]/, {
			description: "/ps entry after expand toggle",
		});
		assert.equal(yield* isDead(session), false);
		assert.match(pane, /\[ps\]/);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
	});

	testEffect("footer accrues real usage after a real task", function* () {
		yield* runTask(
			session,
			"Create a file named ps-e2e.txt whose entire contents are exactly: ps-e2e-ok",
		);
		assert.equal(
			(yield* waitForFile(session, "ps-e2e.txt")).trim(),
			"ps-e2e-ok",
		);

		const pane = yield* waitFor(session, /\$\d+\.\d{3}/, {
			description: "footer cost readout",
		});
		assert.match(pane, /↑\d/, `footer input tokens missing:\n${pane}`);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
	});
});
