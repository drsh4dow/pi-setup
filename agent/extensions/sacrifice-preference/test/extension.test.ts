import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import {
	earlyoomKillSince,
	SACRIFICE_COMMAND_PREFIX,
	sacrificeKillNote,
	tagCommand,
} from "../../../lib/sacrifice.ts";
import {
	BackgroundTerminalManager,
	terminalResultFields,
} from "../../background-terminals/manager.ts";
import { unsafeFixture } from "../../test/adapter.ts";
import sacrificePreference from "../index.ts";

const { execFileSync } = process.getBuiltinModule("node:child_process");

const { chmodSync, mkdtempSync, rmSync, writeFileSync } =
	process.getBuiltinModule("node:fs");

const { tmpdir } = process.getBuiltinModule("node:os");

const { join } = process.getBuiltinModule("node:path");

const linux = process.platform === "linux";

const now = () => Effect.runSync(Clock.currentTimeMillis);

const fakeContext = (cwd: string) =>
	unsafeFixture<ExtensionToolContext>({
		cwd,
		isProjectTrusted: () => false,
		sessionManager: unsafeFixture<ExtensionToolContext["sessionManager"]>({
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
		}),
	});

// Interposing a fake journalctl requires mutating the PATH that spawned
// children inherit; Config only reads the environment.
function fakeJournal(line: string | undefined) {
	const dir = mkdtempSync(join(tmpdir(), "pi-sacrifice-journal-"));
	const script = join(dir, "journalctl");
	writeFileSync(script, `#!/bin/sh\n${line ? `echo '${line}'\n` : ""}`);
	chmodSync(script, 0o755);
	// @effect-diagnostics-next-line processEnv:off
	const previousPath = process.env.PATH;
	// @effect-diagnostics-next-line processEnv:off
	process.env.PATH = `${dir}:${previousPath ?? ""}`;

	return {
		restore: () => {
			// @effect-diagnostics-next-line processEnv:off
			process.env.PATH = previousPath;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const KILL_LINE = 'sending SIGTERM to process 1234 uid 1000 "hog": badness 900';

test("tagCommand marks the shell and its descendants", { skip: !linux }, () => {
	const output = execFileSync(
		"/bin/sh",
		["-c", tagCommand("cat /proc/self/oom_score_adj")],
		{ encoding: "utf8" },
	);

	assert.equal(output.trim(), "500");
});

test("tag statement produces no output or failure", { skip: !linux }, () => {
	const output = execFileSync(
		"/bin/sh",
		["-c", `${SACRIFICE_COMMAND_PREFIX}\necho ok`],
		{ encoding: "utf8" },
	);

	assert.equal(output, "ok\n");
});

test("earlyoomKillSince reads journal evidence", { skip: !linux }, () => {
	const withKill = fakeJournal(KILL_LINE);

	try {
		assert.equal(earlyoomKillSince(now()), true);
	} finally {
		withKill.restore();
	}

	const withoutKill = fakeJournal(undefined);

	try {
		assert.equal(earlyoomKillSince(now()), false);
	} finally {
		withoutKill.restore();
	}
});

test("sacrificeKillNote requires a signal-like death", { skip: !linux }, () => {
	const journal = fakeJournal(KILL_LINE);

	try {
		const since = now();
		assert.match(
			sacrificeKillNote({ exitCode: 137, signal: undefined }, since) ?? "",
			/earlyoom/,
		);
		assert.match(
			sacrificeKillNote({ exitCode: undefined, signal: "SIGKILL" }, since) ??
				"",
			/earlyoom/,
		);
		assert.equal(
			sacrificeKillNote({ exitCode: 7, signal: undefined }, since),
			undefined,
		);
	} finally {
		journal.restore();
	}
});

function registeredBash() {
	let captured: Pick<ToolDefinition, "name" | "execute"> | undefined;
	sacrificePreference(
		unsafeFixture<ExtensionAPI>({
			registerTool: (tool) => {
				captured = tool;
			},
		}),
	);
	assert.ok(captured, "extension registered no tool");
	assert.equal(captured.name, "bash");

	return captured;
}

test("override runs tagged commands transparently", { skip: !linux }, () => {
	const tool = registeredBash();

	return tool
		.execute(
			"t1",
			{ command: "cat /proc/self/oom_score_adj" },
			undefined,
			undefined,
			fakeContext(tmpdir()),
		)
		.then((result) => {
			const text = result.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("");

			assert.equal(text.trim(), "500");
			assert.partialDeepStrictEqual(result.structuredContent, {
				output: "500\n",
				exit_code: 0,
			});
		});
});

test("override passes ordinary failures through unchanged", {
	skip: !linux,
}, () => {
	const tool = registeredBash();

	return tool
		.execute(
			"t2",
			{ command: "exit 7" },
			undefined,
			undefined,
			fakeContext(tmpdir()),
		)
		.then((result) => {
			assert.equal(result.isError, true);
			assert.deepEqual(result.content, [
				{ type: "text", text: "(no output)\n\nCommand exited with code 7" },
			]);
			assert.partialDeepStrictEqual(result.structuredContent, {
				output: "",
				exit_code: 7,
			});
		});
});

test("override annotates a journal-confirmed kill", { skip: !linux }, () => {
	const journal = fakeJournal(KILL_LINE);
	const tool = registeredBash();

	// The trailing exit keeps the tool shell alive past its killed child so the
	// SDK sees exit 137 instead of the shell's own signal death.
	return tool
		.execute(
			"t3",
			{ command: "sh -c 'kill -KILL $$'; code=$?; exit $code" },
			undefined,
			undefined,
			fakeContext(tmpdir()),
		)
		.then((result) => {
			assert.equal(result.isError, true);

			const text = result.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("");

			assert.match(text, /Command exited with code 137/);
			assert.match(text, /earlyoom/);
			assert.partialDeepStrictEqual(result.structuredContent, {
				exit_code: 137,
			});
			assert.match(JSON.stringify(result.structuredContent), /earlyoom/);
		})
		.finally(() => journal.restore());
});

test("manager annotates a journal-confirmed kill", { skip: !linux }, () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const journal = fakeJournal(KILL_LINE);
			const cwd = mkdtempSync(join(tmpdir(), "pi-sacrifice-bg-"));

			try {
				const manager = new BackgroundTerminalManager();

				const started = manager.start({
					command: "sh -c 'kill -KILL $$'; code=$?; exit $code",
					title: "hog",
					cwd,
				});

				const deadline = now() + 6_000;

				while (now() < deadline) {
					const snapshot = manager.get(started.id);

					if (snapshot && snapshot.state !== "running") {
						assert.equal(snapshot.state, "failed");
						assert.match(
							terminalResultFields(snapshot).error ?? "",
							/earlyoom/,
						);
						assert.equal(snapshot.command, started.command);

						return;
					}

					yield* Effect.sleep(20);
				}

				throw new Error("terminal did not settle");
			} finally {
				journal.restore();
				rmSync(cwd, { recursive: true, force: true });
			}
		}),
	),
);
