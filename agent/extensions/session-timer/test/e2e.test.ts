import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
	capture,
	e2eUnavailable,
	isDead,
	type PiSession,
	prompt,
	readStderr,
	runTask,
	sessionElapsedSeconds,
	startPi,
	stop,
	waitFor,
	waitForFile,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();

/** Matches the extension's readout: `⏱ 12s` or `⏱ 1m03s`. */
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
	/** Cumulative session total observed after the first real turn. */
	let firstTotal = 0;

	before(async () => {
		session = await startPi();
	});

	after(async () => {
		if (session) await stop(session);
	});

	test("boots with no timer status before any run", () => {
		assert.equal(isDead(session), false);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);
		const pane = capture(session);
		// agent_start has never fired, so the status slot must be empty.
		assert.doesNotMatch(
			pane,
			RUN_READOUT,
			`unexpected timer at boot:\n${pane}`,
		);
		assert.doesNotMatch(pane, SESSION_READOUT);
	});

	test("ticks an in-flight timer, then reports the run and session totals", async () => {
		// A tool-using task keeps the run comfortably longer than the 1s ticker
		// interval, so the in-flight state is observable rather than a race.
		await prompt(
			session,
			"Create a file named timer-e2e-one.txt whose entire contents are exactly: timer-one",
		);

		// While the run is in flight the ticker prints the elapsed run only —
		// `(session …)` is written once, at agent_end.
		const inFlight = await waitFor(
			session,
			(pane) => RUN_READOUT.test(pane) && !SESSION_READOUT.test(pane),
			{ timeoutMs: 60_000, description: "in-flight ⏱ readout without a total" },
		);
		assert.ok(
			(runSeconds(inFlight) ?? -1) >= 1,
			`in-flight timer should have ticked at least once:\n${inFlight}`,
		);

		const settled = await waitFor(session, SESSION_READOUT, {
			timeoutMs: 120_000,
			description: "session total at agent_end",
		});

		assert.equal(
			(await waitForFile(session, "timer-e2e-one.txt")).trim(),
			"timer-one",
		);

		const run = runSeconds(settled);
		firstTotal = sessionElapsedSeconds(settled) ?? -1;
		assert.ok(run !== undefined, `run readout missing:\n${settled}`);
		assert.ok(firstTotal >= 0, `session readout missing:\n${settled}`);
		// On the very first run the cumulative total *is* that run, so the two
		// readouts are formatted from the same duration and must agree exactly.
		assert.equal(
			firstTotal,
			run,
			`first run and session total should match:\n${settled}`,
		);
		assert.ok(run >= 1, `first run should be at least a second:\n${settled}`);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);
	});

	test("accumulates a monotonic session total across a second turn", async () => {
		const settled = await runTask(
			session,
			"Create a file named timer-e2e-two.txt whose entire contents are exactly: timer-two",
			120_000,
		);
		assert.equal(
			(await waitForFile(session, "timer-e2e-two.txt")).trim(),
			"timer-two",
		);

		const secondRun = runSeconds(settled);
		const secondTotal = sessionElapsedSeconds(settled) ?? -1;
		assert.ok(secondRun !== undefined, `run readout missing:\n${settled}`);
		assert.ok(
			secondTotal > firstTotal,
			`session total must grow: ${firstTotal} -> ${secondTotal}\n${settled}`,
		);
		// The second run is one turn, not the whole session.
		assert.ok(
			secondRun < secondTotal,
			`run readout must be less than the cumulative total:\n${settled}`,
		);
		// total2 == total1 + run2, up to per-readout second rounding.
		assert.ok(
			Math.abs(secondTotal - (firstTotal + secondRun)) <= 1,
			`total ${secondTotal} should be ${firstTotal} + ${secondRun}:\n${settled}`,
		);

		assert.equal(isDead(session), false);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);
	});
});
