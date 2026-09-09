import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { DelegateSessionParams } from "../contract.ts";

function validate(args: Record<string, unknown>): unknown {
	return validateToolArguments(
		{
			name: "delegate_session",
			description: "Manage delegated children",
			parameters: DelegateSessionParams,
		},
		{
			type: "toolCall",
			id: "session-1",
			name: "delegate_session",
			arguments: args,
		},
	);
}

test("session actions require their own inputs before execution", () => {
	assert.deepEqual(validate({ action: "list" }), { action: "list" });
	assert.deepEqual(
		validate({
			action: "send",
			id: "delegate-2",
			message: "Protect user files.",
		}),
		{
			action: "send",
			id: "delegate-2",
			message: "Protect user files.",
		},
	);
	assert.throws(() => validate({ action: "send", id: "delegate-2" }));
	assert.throws(() =>
		validate({ action: "send", message: "Protect user files." }),
	);
	for (const action of ["status", "cancel"]) {
		assert.deepEqual(validate({ action, ids: ["delegate-2"] }), {
			action,
			ids: ["delegate-2"],
		});
		assert.throws(() => validate({ action }));
		assert.throws(() => validate({ action, ids: [] }));
	}
});
