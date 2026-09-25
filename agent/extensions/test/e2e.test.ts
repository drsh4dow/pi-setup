import assert from "node:assert/strict";
// Pure path operations do not need an Effect service.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { basename } from "node:path";
import { describe } from "node:test";
import {
	capture,
	e2eUnavailable,
	isDead,
	type PiSession,
	prompt,
	readStderr,
	setupPiSession,
	testEffect,
	waitFor,
} from "./tmux.ts";

const SESSION_DURATION = /⏱️?\s*(?:\d+d\s*)?(?:\d+h\s*)?(?:\d+m\s*)?\d+s/;

describe("UI extensions (real pi in tmux)", { skip: e2eUnavailable() }, () => {
	let session: PiSession;

	setupPiSession((value) => {
		session = value;
	});

	testEffect(
		"renders the header and retains duration and throughput after a real turn",
		function* () {
			const initial = yield* capture(session);
			const header = / PI \/ (\S+) \/ (\S+) /.exec(initial);
			assert.ok(header, `header missing from startup:\n${initial}`);
			assert.equal(header[1], /\([^\n)]+\)\s+(\S+)\s+•/.exec(initial)?.[1]);
			assert.equal(header[2], basename(session.cwd));
			assert.doesNotMatch(initial, SESSION_DURATION);
			assert.doesNotMatch(initial, /tok\/s/);

			yield* prompt(
				session,
				"Write a twelve-line poem about programming. Do not use any tools.",
			);
			yield* waitFor(session, SESSION_DURATION, {
				timeoutMs: 60_000,
				description: "session duration after the first user message",
			});

			const settled = yield* waitFor(session, /done – \d+ tok\/s/, {
				timeoutMs: 180_000,
				description: "retained throughput after the turn settles",
			});

			assert.equal(
				[...settled.matchAll(new RegExp(SESSION_DURATION, "g"))].length,
				2,
				`expected a response footer and status-bar duration:\n${settled}`,
			);
			assert.match(settled, /✓ \d+ tok\/s\s+\d+ tokens in \d+\.\d+s streaming/);
			assert.equal(yield* isDead(session), false);
			assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		},
	);
});
