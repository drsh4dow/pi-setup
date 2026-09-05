import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { Effect } from "effect";
import {
	capture,
	e2eUnavailable,
	isDead,
	type PiSession,
	prompt,
	readStderr,
	sessionElapsedSeconds,
	setupPiSession,
	testEffect,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();

const TURN_TIMEOUT_MS = 180_000;
const FRAME_POLL_MS = 100;

const SESSION_TIMER_PREFIX = /^⏱ (?:\d+m)?\d+s (?:\(session (?:\d+m)?\d+s\) )?/;
const STREAMING_STATUS = /^\d+ tok\/s \(~?\d+ tok \/ \d+\.\d+s\)$/;
const DONE_STATUS = /^done — \d+ tok\/s$/;

function statusLine(pane: string): string {
	const lines = pane.split("\n").map((line) => line.trimEnd());
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() !== "") return lines[i].trim();
	}
	return "";
}

const runTaskSamplingStatus = Effect.fn("runTaskSamplingStatus")(function* (
	session: PiSession,
	text: string,
) {
	const before = sessionElapsedSeconds(yield* capture(session));
	const frames: string[] = [];
	const seen = new Set<string>();

	yield* prompt(session, text);
	const poll = Effect.gen(function* () {
		const pane = yield* capture(session);
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
			return { done: true, pane };
		}
		if (yield* isDead(session)) {
			return yield* Effect.die(
				new Error(
					`pi exited during the tps turn\n--- stderr ---\n${yield* readStderr(session)}\n--- pane ---\n${pane}`,
				),
			);
		}
		yield* Effect.sleep(FRAME_POLL_MS);
		return { done: false, pane };
	}).pipe(Effect.repeat({ until: ({ done }) => done }));

	const { pane } = yield* poll.pipe(
		Effect.timeoutOrElse({
			duration: TURN_TIMEOUT_MS,
			orElse: () =>
				Effect.gen(function* () {
					return yield* Effect.die(
						new Error(
							`timed out after ${TURN_TIMEOUT_MS}ms waiting for the tps turn to settle\n` +
								`--- frames ---\n${frames.join("\n")}\n--- pane ---\n${yield* capture(session)}`,
						),
					);
				}),
		}),
	);
	return { frames, pane };
});

describe("tps-tracker (real pi in tmux)", { skip }, () => {
	let session: PiSession;
	let frames: string[] = [];
	let settledPane = "";

	setupPiSession((value) => {
		session = value;
	});

	testEffect("boots with no tps readout before the first turn", function* () {
		assert.equal(yield* isDead(session), false);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		const pane = yield* capture(session);
		assert.doesNotMatch(
			pane,
			/tok\/s/,
			`tps status painted before any agent run:\n${pane}`,
		);
	});

	testEffect(
		"paints the generating → done progression across one real turn",
		function* () {
			({ frames, pane: settledPane } = yield* runTaskSamplingStatus(
				session,
				"Write a four line poem about tokens per second. Do not use any tools.",
			));

			assert.ok(
				frames.some((line) => line.includes("⏱ generating...")),
				`never saw the '⏱ generating...' status frame:\n${frames.join("\n")}`,
			);

			for (const frame of frames) {
				if (!frame.includes("tok/s")) continue;
				const body = frame.replace(SESSION_TIMER_PREFIX, "");
				assert.ok(
					STREAMING_STATUS.test(body) || DONE_STATUS.test(body),
					`unrecognised tps status frame: ${body}\n` +
						`all frames:\n${frames.join("\n")}`,
				);
			}

			assert.equal(yield* isDead(session), false);
			assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		},
	);

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
		// Sub-50ms streams round to 0.0s; the rate uses unrounded elapsed time.
		assert.ok(
			Number(summary[1]) > 0,
			`summary reported a non-positive rate: ${summary[0]}`,
		);
		assert.equal(
			summary[1],
			/done — (\d+) tok\/s/.exec(statusLine(settledPane))?.[1],
			`notification and status bar disagree on the rate:\n${settledPane}`,
		);
	});
});
