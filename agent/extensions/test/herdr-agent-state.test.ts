import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const extensionUrl = new URL("../herdr-agent-state.ts", import.meta.url);

test("stays inert when Pi is not running inside Herdr", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`import extension from ${JSON.stringify(extensionUrl.href)};
extension(new Proxy({}, { get() { process.exit(2); } }));`,
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				HERDR_ENV: "0",
				HERDR_PANE_ID: "",
				HERDR_SOCKET_PATH: "",
			},
		},
	);

	assert.equal(result.status, 0, result.stderr);
});
