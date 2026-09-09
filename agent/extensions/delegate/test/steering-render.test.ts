import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { renderDelegateSessionResult } from "../render.ts";
import { snapshot } from "./snapshot.ts";

initTheme();
const theme = new Theme(
	{
		accent: "",
		border: "",
		borderAccent: "",
		borderMuted: "",
		success: "",
		error: "",
		warning: "",
		muted: "",
		dim: "",
		text: "",
		thinkingText: "",
		userMessageText: "",
		customMessageText: "",
		customMessageLabel: "",
		toolTitle: "",
		toolOutput: "",
		mdHeading: "",
		mdLink: "",
		mdLinkUrl: "",
		mdCode: "",
		mdCodeBlock: "",
		mdCodeBlockBorder: "",
		mdQuote: "",
		mdQuoteBorder: "",
		mdHr: "",
		mdListBullet: "",
		toolDiffAdded: "",
		toolDiffRemoved: "",
		toolDiffContext: "",
		syntaxComment: "",
		syntaxKeyword: "",
		syntaxFunction: "",
		syntaxVariable: "",
		syntaxString: "",
		syntaxNumber: "",
		syntaxType: "",
		syntaxOperator: "",
		syntaxPunctuation: "",
		thinkingOff: "",
		thinkingMinimal: "",
		thinkingLow: "",
		thinkingMedium: "",
		thinkingHigh: "",
		thinkingXhigh: "",
		bashMode: "",
	},
	{
		selectedBg: "",
		userMessageBg: "",
		customMessageBg: "",
		toolPendingBg: "",
		toolSuccessBg: "",
		toolErrorBg: "",
	},
	"truecolor",
);

function render(
	message: string,
	expanded = false,
	isError = false,
	legacySnapshot = false,
) {
	return renderDelegateSessionResult(
		{
			content: [
				{
					type: "text",
					text: isError
						? "Child has settled."
						: "Steering queued for delegate-2.",
				},
			],
			details: legacySnapshot
				? snapshot({ assignedTask: "Remove delegate wait end-to-end." })
				: undefined,
		},
		{ expanded, isPartial: false },
		theme,
		{
			args: { action: "send", id: "delegate-2", message },
			toolCallId: "send-1",
			invalidate() {},
			lastComponent: undefined,
			state: undefined,
			cwd: process.cwd(),
			executionStarted: true,
			argsComplete: true,
			isPartial: false,
			expanded,
			showImages: false,
			isError,
		},
	)
		.render(120)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.join("\n");
}

test("send displays its queued update instead of the original task", () => {
	assert.equal(
		render("Leave agent/prompts/wait-what.md untouched."),
		"Steering queued for delegate-2.\nLeave agent/prompts/wait-what.md untouched.",
	);
	assert.equal(
		render("Leave agent/prompts/wait-what.md untouched.", false, false, true),
		"Steering queued for delegate-2.\nLeave agent/prompts/wait-what.md untouched.",
	);
});

test("long updates have a bounded preview and expand to the full message", () => {
	const message =
		"Protect user files.\nKeep delivery guards.\nAvoid unrelated edits.\nRun tests.\nReport failures.";
	const collapsed = render(message);
	assert.match(collapsed, /Protect user files\.[\s\S]*Run tests\./);
	assert.doesNotMatch(collapsed, /Report failures/);
	assert.match(collapsed, /expand steering message/);
	assert.match(render(message, true), /Run tests\.\nReport failures\./);

	const singleLine = `Protect ${"x".repeat(500)} marker-at-end`;
	assert.match(render(singleLine), /Protect\s+x+/);
	assert.doesNotMatch(render(singleLine), /marker-at-end/);
	assert.match(render(singleLine, true), /marker-at-end/);
});

test("a rejected update displays the error without claiming it was queued", () => {
	assert.equal(
		render("Do not change files.", false, true),
		"failed • Child has settled.",
	);
});
