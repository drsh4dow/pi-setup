import assert from "node:assert/strict";
import { describe } from "node:test";
import {
	capture,
	e2eUnavailable,
	isDead,
	type PiSession,
	prompt,
	readStderr,
	sendKeys,
	setupPiSession,
	testEffect,
	waitFor,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();

describe("process-status (real pi in tmux)", { skip }, () => {
	let session: PiSession;

	setupPiSession((value) => {
		session = value;
	});

	testEffect("boots with the built-in footer", function* () {
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
});
