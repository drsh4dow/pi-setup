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
	sessionElapsedSeconds,
	setupPiSession,
	testEffect,
	waitFor,
	waitForFile,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();

const RUN_READOUT = /⏱️?\s*((?:\d+m)?\d+s)/;
const SESSION_READOUT = /\(session ((?:\d+m)?\d+s)\)/;

function toSeconds(readout: string): number {
	const match = /^(?:(\d+)m)?(\d+)s$/.exec(readout);
	assert.ok(match, `unparseable timer readout: ${readout}`);
	return Number(match[1] ?? 0) * 60 + Number(match[2]);
}

function runSeconds(pane: string): number | undefined {
	const match = RUN_READOUT.exec(pane);
	return match ? toSeconds(match[1]) : undefined;
}

describe("session-timer (real pi in tmux)", { skip }, () => {
	let session: PiSession;
	let firstTotal = 0;

	setupPiSession((value) => {
		session = value;
	});

	testEffect("boots with no timer status before any run", function* () {
		assert.equal(yield* isDead(session), false);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		const pane = yield* capture(session);
		assert.doesNotMatch(
			pane,
			RUN_READOUT,
			`unexpected timer at boot:\n${pane}`,
		);
		assert.doesNotMatch(pane, SESSION_READOUT);
	});

	testEffect(
		"ticks an in-flight timer, then reports the run and session totals",
		function* () {
			yield* prompt(
				session,
				"Create a file named timer-e2e-one.txt whose entire contents are exactly: timer-one",
			);

			const inFlight = yield* waitFor(
				session,
				(pane) => RUN_READOUT.test(pane) && !SESSION_READOUT.test(pane),
				{
					timeoutMs: 60_000,
					description: "in-flight ⏱ readout without a total",
				},
			);
			assert.ok(
				(runSeconds(inFlight) ?? -1) >= 1,
				`in-flight timer should have ticked at least once:\n${inFlight}`,
			);

			const settled = yield* waitFor(session, SESSION_READOUT, {
				timeoutMs: 120_000,
				description: "session total at agent_end",
			});

			assert.equal(
				(yield* waitForFile(session, "timer-e2e-one.txt")).trim(),
				"timer-one",
			);

			const runSecondsSettled = runSeconds(settled);
			firstTotal = sessionElapsedSeconds(settled) ?? -1;
			assert.ok(
				runSecondsSettled !== undefined,
				`run readout missing:\n${settled}`,
			);
			assert.ok(firstTotal >= 0, `session readout missing:\n${settled}`);
			assert.equal(
				firstTotal,
				runSecondsSettled,
				`first run and session total should match:\n${settled}`,
			);
			assert.ok(
				runSecondsSettled >= 1,
				`first run should be at least a second:\n${settled}`,
			);
			assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		},
	);

	testEffect(
		"accumulates a monotonic session total across a second turn",
		function* () {
			const settled = yield* runTask(
				session,
				"Create a file named timer-e2e-two.txt whose entire contents are exactly: timer-two",
				120_000,
			);
			assert.equal(
				(yield* waitForFile(session, "timer-e2e-two.txt")).trim(),
				"timer-two",
			);

			const secondRun = runSeconds(settled);
			const secondTotal = sessionElapsedSeconds(settled) ?? -1;
			assert.ok(secondRun !== undefined, `run readout missing:\n${settled}`);
			assert.ok(
				secondTotal > firstTotal,
				`session total must grow: ${firstTotal} -> ${secondTotal}\n${settled}`,
			);
			assert.ok(
				secondRun < secondTotal,
				`run readout must be less than the cumulative total:\n${settled}`,
			);
			assert.ok(
				Math.abs(secondTotal - (firstTotal + secondRun)) <= 1,
				`total ${secondTotal} should be ${firstTotal} + ${secondRun}:\n${settled}`,
			);

			assert.equal(yield* isDead(session), false);
			assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		},
	);
});
