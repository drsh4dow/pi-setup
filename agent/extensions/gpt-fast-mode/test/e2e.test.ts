import assert from "node:assert/strict";
import { describe } from "node:test";
import { Effect } from "effect";
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
import {
	fastServiceTier,
	loadEnabled,
	resolveFastModeSettingsPath,
} from "../index.ts";

const skip = e2eUnavailable();

const persistedEnabled = (session: PiSession) =>
	Effect.promise(() =>
		loadEnabled({ env: { PI_CODING_AGENT_DIR: session.agentDir } }),
	);

function footerModel(pane: string): { provider: string; id: string } {
	const matches = [...pane.matchAll(/\(([a-z0-9-]+)\)\s+(\S+)\s+•/g)];
	const last = matches.at(-1);
	assert.ok(last, `could not read the footer model from pane:\n${pane}`);
	return { provider: last[1], id: last[2] };
}

function noticeFor(enabled: boolean, model: { provider: string; id: string }) {
	if (!enabled) return /GPT Fast mode disabled\./;
	const serviceTier = fastServiceTier(model);
	return serviceTier
		? new RegExp(`GPT Fast mode enabled \\(service_tier: ${serviceTier}\\)\\.`)
		: /GPT Fast mode enabled, but .+ is not supported\./;
}

describe("gpt-fast-mode (real pi in tmux)", { skip }, () => {
	let session: PiSession;
	let model: { provider: string; id: string };
	let initialEnabled: boolean;
	let expected: boolean;

	setupPiSession(
		(value) => {
			session = value;
		},
		(value) =>
			Effect.gen(function* () {
				initialEnabled = yield* persistedEnabled(value);
				expected = initialEnabled;
				model = footerModel(yield* capture(value));
			}),
	);

	const toggle = Effect.fn("toggle")(function* <E>(
		trigger: Effect.Effect<void, E>,
		description: string,
	) {
		const next = !expected;
		yield* trigger;
		const pane = yield* waitFor(session, noticeFor(next, model), {
			timeoutMs: 30_000,
			description,
		});
		expected = next;
		assert.doesNotMatch(pane, noticeFor(!next, model));
		assert.equal(
			yield* persistedEnabled(session),
			next,
			`${yield* Effect.promise(() => resolveFastModeSettingsPath({ env: { PI_CODING_AGENT_DIR: session.agentDir } }))} does not reflect the announced state`,
		);
		assert.equal(yield* isDead(session), false);
	});

	testEffect("registers the extension without crashing", function* () {
		assert.equal(yield* isDead(session), false);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		const pane = yield* capture(session);
		assert.match(
			pane,
			/\[Extensions\][\s\S]*gpt-fast-mode/,
			`gpt-fast-mode missing from the startup banner:\n${pane}`,
		);
	});

	testEffect("/fast flips the announced state and persists it", function* () {
		yield* toggle(prompt(session, "/fast"), "first /fast notice");
		assert.notEqual(
			yield* persistedEnabled(session),
			initialEnabled,
			"/fast did not change the persisted setting",
		);
	});

	testEffect("/fast again flips back to the original state", function* () {
		yield* toggle(prompt(session, "/fast"), "second /fast notice");
		assert.equal(yield* persistedEnabled(session), initialEnabled);
	});

	testEffect("the ctrl+alt+m shortcut toggles the same state", function* () {
		yield* toggle(sendKeys(session, "C-M-m"), "shortcut notice (off)");
		yield* toggle(sendKeys(session, "C-M-m"), "shortcut notice (back on)");
		assert.equal(yield* persistedEnabled(session), initialEnabled);
	});

	testEffect("survives the toggles cleanly", function* () {
		assert.equal(yield* isDead(session), false);
		assert.doesNotMatch(yield* readStderr(session), /uncaughtException/);
		const pane = yield* capture(session);
		assert.match(pane, /%\/\d/, `footer stopped rendering:\n${pane}`);
	});
});
