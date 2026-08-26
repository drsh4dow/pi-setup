import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	formatStorageQuotaError,
	recoverStorageQuota,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/diagnostics.js";
import { findPiPackageRoot } from "../../scripts/sync-pi-patches.mjs";

const outputAccumulatorUrl = pathToFileURL(
	`${process.cwd()}/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/output-accumulator.js`,
).href;
const bashExecutorUrl = pathToFileURL(
	`${process.cwd()}/node_modules/@earendil-works/pi-coding-agent/dist/core/bash-executor.js`,
).href;

test("Linux EDQUOT errors name the quota and recovery path", () => {
	const message = formatStorageQuotaError({
		code: "Unknown system error -122",
		errno: -122,
		syscall: "write",
	});

	assert.match(message ?? "", /Storage quota exceeded.*EDQUOT; errno -122/);
	assert.match(message ?? "", /clear stale files under \/tmp or set TMPDIR/);
	assert.equal(formatStorageQuotaError(new Error("other failure")), undefined);
});

test("EDQUOT invokes oldest-first temporary-space recovery", (t) => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(process.cwd(), "agent");
	t.after(() => {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});
	const root = mkdtempSync(join(tmpdir(), "pi-runtime-recovery-test-"));
	try {
		writeFileSync(join(root, "pi-output-old.log"), Buffer.alloc(128 * 1024));
		const message = recoverStorageQuota(
			{ code: "Unknown system error -122", errno: -122 },
			{ directory: root, requiredBytes: 0 },
		);

		assert.match(
			message ?? "",
			/Automatic cleanup deleted 1 oldest temporary entry/,
		);
		assert.match(message ?? "", /30% safety reserve/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy bash temp-write errors also reach the caller", () => {
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`import { executeBashWithOperations } from ${JSON.stringify(bashExecutorUrl)};
const operations = {
  async exec(_command, _cwd, options) {
    options.onData(Buffer.alloc(64 * 1024, 1));
    await new Promise((resolve) => setImmediate(resolve));
    return { exitCode: 0 };
  },
};
try {
  await executeBashWithOperations("ignored", process.cwd(), operations);
  process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}`,
		],
		{
			encoding: "utf8",
			env: { ...process.env, TMPDIR: "/dev/full" },
		},
	);

	assert.equal(child.status, 0, child.stderr);
	assert.match(
		child.stderr,
		/Failed to save full command output to \/dev\/full\/pi-bash-/,
	);
});

test("temp output write errors reach the tool instead of crashing Pi", () => {
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`import { OutputAccumulator } from ${JSON.stringify(outputAccumulatorUrl)};
const output = new OutputAccumulator({ maxBytes: 1 });
output.append(Buffer.from("too large"));
await new Promise((resolve) => setImmediate(resolve));
try {
  await output.closeTempFile();
  process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}`,
		],
		{
			encoding: "utf8",
			env: { ...process.env, TMPDIR: "/dev/full" },
		},
	);

	assert.equal(child.status, 0, child.stderr);
	assert.match(
		child.stderr,
		/Failed to save full command output to \/dev\/full\/pi-output-[a-f0-9]+\.log:/,
	);
});

test("patch sync finds the package root for a bundled Pi executable", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-package-root-test-"));
	try {
		const executable = join(root, "dist", "bundle", "cli.js");
		mkdirSync(join(root, "dist", "bundle"), { recursive: true });
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent" }),
		);
		writeFileSync(executable, "");

		assert.equal(findPiPackageRoot(executable), root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("patch sync permits dependency installation without an active Pi", () => {
	const child = spawnSync(
		process.execPath,
		["agent/scripts/sync-pi-patches.mjs"],
		{
			encoding: "utf8",
			env: { ...process.env, PATH: "" },
		},
	);

	assert.equal(child.status, 0, child.stderr);
	assert.match(child.stdout, /No external pi executable found on PATH/);
});
