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
	sendKeys,
	startPi,
	stop,
	waitFor,
	waitForFile,
} from "../../test/tmux.ts";

const skip = e2eUnavailable();

describe("process-status (real pi in tmux)", { skip }, () => {
	let session: PiSession;

	before(async () => {
		session = await startPi();
	});

	after(async () => {
		if (session) await stop(session);
	});

	test("boots the replacement footer without crashing", () => {
		// Regression: the footer's fake AgentSession omitted modelRegistry, so the
		// first render threw and pi exited before the user could type anything.
		assert.equal(isDead(session), false);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);
		const pane = capture(session);
		assert.match(pane, /%\/\d/, `footer context gauge missing:\n${pane}`);
	});

	test("/ps reports an idle process list", async () => {
		await prompt(session, "/ps");
		const pane = await waitFor(session, /\[ps\]/, {
			description: "/ps entry",
		});
		assert.match(pane, /\[ps\].*idle/);
	});

	test("Ctrl+O keeps the expanded /ps entry renderable", async () => {
		await sendKeys(session, "C-o");
		const pane = await waitFor(session, /\[ps\]/, {
			description: "/ps entry after expand toggle",
		});
		assert.equal(isDead(session), false);
		assert.match(pane, /\[ps\]/);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);
	});

	test("footer accrues real usage after a real task", async () => {
		await runTask(
			session,
			"Create a file named ps-e2e.txt whose entire contents are exactly: ps-e2e-ok",
		);
		assert.equal(
			(await waitForFile(session, "ps-e2e.txt")).trim(),
			"ps-e2e-ok",
		);

		const pane = await waitFor(session, /\$\d+\.\d{3}/, {
			description: "footer cost readout",
		});
		assert.match(pane, /↑\d/, `footer input tokens missing:\n${pane}`);
		assert.doesNotMatch(readStderr(session), /uncaughtException/);
	});
});
