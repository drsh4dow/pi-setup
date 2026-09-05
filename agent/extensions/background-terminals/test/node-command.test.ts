import assert from "node:assert/strict";
import test from "node:test";
import { nodeCommand } from "./node-command.ts";

const { execSync } = process.getBuiltinModule("node:child_process");

test("Node fixture commands preserve Unicode and shell metacharacters", () => {
	const text = "é ' \" $HOME %PATH% !PATH! & | < > ^ ` \\ \n";
	const command = nodeCommand(`process.stdout.write(${JSON.stringify(text)})`);
	assert.match(
		command,
		/^node -e "eval\(Buffer\.from\('[A-Za-z0-9+/=]+','base64'\)\.toString\(\)\)"$/,
	);
	assert.equal(execSync(command, { encoding: "utf8" }), text);
});
