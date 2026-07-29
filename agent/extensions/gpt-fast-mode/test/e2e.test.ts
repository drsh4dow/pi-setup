import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
	capture,
	e2eUnavailable,
	isDead,
	type PiSession,
	prompt,
	readStderr,
	sendKeys,
	startPi,
	stop,
	waitFor,
} from "../../test/tmux.ts";
import {
	isSupportedModel,
	loadEnabled,
	resolveFastModeSettingsPath,
} from "../index.ts";

const skip = e2eUnavailable();

function persistedEnabled(session: PiSession): Promise<boolean> {
	return loadEnabled({
		env: { PI_CODING_AGENT_DIR: session.agentDir },
	});
}

/** The footer prints `(provider) model •`; the cost gauge parens never do. */
function footerModel(pane: string): { provider: string; id: string } {
	const matches = [...pane.matchAll(/\(([a-z0-9-]+)\)\s+(\S+)\s+•/g)];
	const last = matches.at(-1);
	assert.ok(last, `could not read the footer model from pane:\n${pane}`);
	return { provider: last[1], id: last[2] };
}

function noticeFor(enabled: boolean, model: { provider: string; id: string }) {
	if (!enabled) return /GPT Fast mode disabled\./;
	return isSupportedModel(model)
		? /GPT Fast mode enabled \(service_tier: priority\)\./
		: /GPT Fast mode enabled, but .+ is not supported\./;
}

describe("gpt-fast-mode (real pi in tmux)", { skip }, () => {
	let session: PiSession;
	let model: { provider: string; id: string };
	let initialEnabled: boolean;
	/** Flipped by every toggle so each step knows which notice to expect. */
	let expected: boolean;

	before(async () => {
		session = await startPi();
		initialEnabled = await persistedEnabled(session);
		expected = initialEnabled;
		model = footerModel(capture(session));
	});

	after(async () => {
		if (session) await stop(session);
	});

	/** Toggles once and waits for the notice that names the new state. */
	async function toggle(
		trigger: () => Promise<void>,
		description: string,
	): Promise<void> {
		const next = !expected;
		await trigger();
		// Only one notice is rendered at a time and it is replaced in place, so
		// waiting for the opposite state is an unambiguous edge.
		const pane = await waitFor(session, noticeFor(next, model), {
			timeoutMs: 30_000,
			description,
		});
		expected = next;
		assert.doesNotMatch(pane, noticeFor(!next, model));
		assert.equal(
			await persistedEnabled(session),
			next,
			`${await resolveFastModeSettingsPath({ env: { PI_CODING_AGENT_DIR: session.agentDir } })} does not reflect the announced state`,
		);
		assert.equal(isDead(session), false);
	}

	test("registers the extension without crashing", () => {
		assert.equal(isDead(session), false);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);
		const pane = capture(session);
		assert.match(
			pane,
			/\[Extensions\][\s\S]*gpt-fast-mode/,
			`gpt-fast-mode missing from the startup banner:\n${pane}`,
		);
	});

	test("/fast flips the announced state and persists it", async () => {
		await toggle(() => prompt(session, "/fast"), "first /fast notice");
		assert.notEqual(
			await persistedEnabled(session),
			initialEnabled,
			"/fast did not change the persisted setting",
		);
	});

	test("/fast again flips back to the original state", async () => {
		await toggle(() => prompt(session, "/fast"), "second /fast notice");
		assert.equal(await persistedEnabled(session), initialEnabled);
	});

	test("the ctrl+alt+m shortcut toggles the same state", async () => {
		await toggle(() => sendKeys(session, "C-M-m"), "shortcut notice (off)");
		await toggle(() => sendKeys(session, "C-M-m"), "shortcut notice (back on)");
		assert.equal(await persistedEnabled(session), initialEnabled);
	});

	test("survives the toggles cleanly", () => {
		assert.equal(isDead(session), false);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);
		const pane = capture(session);
		assert.match(pane, /%\/\d/, `footer stopped rendering:\n${pane}`);
	});
});
