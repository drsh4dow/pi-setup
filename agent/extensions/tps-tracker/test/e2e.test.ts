import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
	capture,
	e2eUnavailable,
	isDead,
	type PiSession,
	prompt,
	readStderr,
	sessionElapsedSeconds,
	startPi,
	stop,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();

const TURN_TIMEOUT_MS = 180_000;
const FRAME_POLL_MS = 100;

/** `⏱ 5s (session 5s) done — 1257 tok/s` → `done — 1257 tok/s`. */
const SESSION_TIMER_PREFIX = /^⏱ (?:\d+m)?\d+s (?:\(session (?:\d+m)?\d+s\) )?/;
/** The two shapes tps-tracker is allowed to paint once it has a rate. */
const STREAMING_STATUS = /^\d+ tok\/s \(~?\d+ tok \/ \d+\.\d+s\)$/;
const DONE_STATUS = /^done — \d+ tok\/s$/;

/** The status bar is the last painted line of the pane. */
function statusLine(pane: string): string {
	const lines = pane.split("\n").map((line) => line.trimEnd());
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() !== "") return lines[i].trim();
	}
	return "";
}

/**
 * Submits a prompt and samples the status bar until the turn settles, so the
 * transient `generating`/streaming frames are observed and not just the final
 * one. Settling uses the same monotonic `(session …)` edge as `runTask`.
 */
async function runTaskSamplingStatus(
	session: PiSession,
	text: string,
): Promise<{ frames: string[]; pane: string }> {
	const before = sessionElapsedSeconds(capture(session));
	const frames: string[] = [];
	const seen = new Set<string>();

	await prompt(session, text);

	const deadline = Date.now() + TURN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const pane = capture(session);
		const line = statusLine(pane);
		if (
			(line.includes("tok/s") || line.includes("generating")) &&
			!seen.has(line)
		) {
			seen.add(line);
			frames.push(line);
		}

		const now = sessionElapsedSeconds(pane);
		if (now !== undefined && (before === undefined || now > before)) {
			return { frames, pane };
		}
		if (isDead(session)) {
			throw new Error(
				`pi exited during the tps turn\n--- stderr ---\n${readStderr(session)}\n--- pane ---\n${pane}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, FRAME_POLL_MS));
	}

	throw new Error(
		`timed out after ${TURN_TIMEOUT_MS}ms waiting for the tps turn to settle\n` +
			`--- frames ---\n${frames.join("\n")}\n--- pane ---\n${capture(session)}`,
	);
}

describe("tps-tracker (real pi in tmux)", { skip }, () => {
	let session: PiSession;
	let frames: string[] = [];
	let settledPane = "";

	before(async () => {
		session = await startPi();
	});

	after(async () => {
		if (session) await stop(session);
	});

	test("boots with no tps readout before the first turn", () => {
		assert.equal(isDead(session), false);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);
		const pane = capture(session);
		assert.doesNotMatch(
			pane,
			/tok\/s/,
			`tps status painted before any agent run:\n${pane}`,
		);
	});

	test("paints the generating → done progression across one real turn", async () => {
		({ frames, pane: settledPane } = await runTaskSamplingStatus(
			session,
			"Write a four line poem about tokens per second. Do not use any tools.",
		));

		assert.ok(
			frames.some((line) => line.includes("⏱ generating...")),
			`never saw the '⏱ generating...' status frame:\n${frames.join("\n")}`,
		);

		// Every rate frame the tracker paints must be one of its two formats:
		// the live streaming readout or the terminal done readout.
		for (const frame of frames) {
			if (!frame.includes("tok/s")) continue;
			const body = frame.replace(SESSION_TIMER_PREFIX, "");
			assert.ok(
				STREAMING_STATUS.test(body) || DONE_STATUS.test(body),
				`unrecognised tps status frame: ${JSON.stringify(body)}\n` +
					`all frames:\n${frames.join("\n")}`,
			);
		}

		assert.equal(isDead(session), false);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);
	});

	test("settles on a done readout with a positive rate", () => {
		const done = /done — (\d+) tok\/s/.exec(statusLine(settledPane));
		assert.ok(
			done,
			`no 'done — N tok/s' status after the turn:\n${settledPane}`,
		);
		assert.ok(
			Number(done[1]) > 0,
			`done readout reported a non-positive rate: ${done[0]}`,
		);
	});

	test("notifies the streaming summary in the transcript", () => {
		const summary =
			/✓ (\d+) tok\/s\s+(\d+) tokens in (\d+\.\d+)s streaming/.exec(
				settledPane,
			);
		assert.ok(
			summary,
			`no tps summary notification in the transcript:\n${settledPane}`,
		);
		assert.ok(
			Number(summary[2]) > 0,
			`summary reported zero output tokens: ${summary[0]}`,
		);
		assert.ok(
			Number(summary[3]) > 0,
			`summary reported zero streaming time: ${summary[0]}`,
		);
		// The notification and the status bar describe the same run.
		assert.equal(
			summary[1],
			/done — (\d+) tok\/s/.exec(statusLine(settledPane))?.[1],
			`notification and status bar disagree on the rate:\n${settledPane}`,
		);
	});
});
