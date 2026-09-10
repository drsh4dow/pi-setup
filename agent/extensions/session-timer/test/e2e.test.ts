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
	setupPiSession,
	testEffect,
	waitFor,
	waitForFile,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();

const RUN_READOUT = /⏱️?\s*((?:\d+m)?\d+s)/;

describe("session-timer (real pi in tmux)", { skip }, () => {
	let session: PiSession;

	setupPiSession((value) => {
		session = value;
	});

	testEffect("boots with no timer status before any run", function* () {
		assert.equal(yield* isDead(session), false);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		assert.doesNotMatch(yield* capture(session), RUN_READOUT);
	});

	testEffect(
		"shows a live timer and removes it when the turn settles",
		function* () {
			yield* prompt(
				session,
				"Create a file named timer-e2e-one.txt whose entire contents are exactly: timer-one",
			);

			const inFlight = yield* waitFor(session, RUN_READOUT, {
				timeoutMs: 60_000,
				description: "in-flight timer",
			});

			assert.match(inFlight, RUN_READOUT);

			const settled = yield* waitFor(session, /done – (?:\d+ tok\/s|N\/A)/, {
				timeoutMs: 120_000,
				description: "retained completion status",
			});

			assert.doesNotMatch(settled, RUN_READOUT);
			assert.equal(
				(yield* waitForFile(session, "timer-e2e-one.txt")).trim(),
				"timer-one",
			);
		},
	);

	testEffect("keeps the settled timer absent on a later turn", function* () {
		const settled = yield* runTask(
			session,
			"Create a file named timer-e2e-two.txt whose entire contents are exactly: timer-two",
			120_000,
		);

		assert.doesNotMatch(settled, RUN_READOUT);
		assert.equal(
			(yield* waitForFile(session, "timer-e2e-two.txt")).trim(),
			"timer-two",
		);
		assert.equal(yield* isDead(session), false);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
	});
});
