import assert from "node:assert/strict";
import { Effect } from "effect";

const { mkdtempSync, readFileSync, rmSync, writeFileSync } =
	process.getBuiltinModule("node:fs");

import { tmpdir } from "node:os";

const { join } = process.getBuiltinModule("node:path");

import { test } from "node:test";
import { createDiagnosticEditTool } from "../index.ts";

function fixture(
	text: string,
	run: (cwd: string, path: string) => Effect.Effect<void>,
) {
	const cwd = mkdtempSync(join(tmpdir(), "edit-feedback-"));
	const path = join(cwd, "fixture.txt");
	writeFileSync(path, text);
	return Effect.runPromise(
		run(cwd, path).pipe(
			Effect.ensuring(
				Effect.sync(() => rmSync(cwd, { recursive: true, force: true })),
			),
		),
	);
}

test("ambiguity shows candidate line locations and surrounding text without writes", () =>
	fixture(
		"first section\nrepeat\nend first\nsecond section\nrepeat\nend second\n",
		(cwd, path) =>
			Effect.gen(function* () {
				const before = readFileSync(path);
				const tool = createDiagnosticEditTool(cwd);
				yield* Effect.promise(() =>
					assert.rejects(
						tool.execute("test", {
							path,
							edits: [{ oldText: "repeat", newText: "changed" }],
						}),
						/2:.*repeat[\s\S]*5:.*repeat/,
					),
				);
				assert.deepEqual(readFileSync(path), before);
			}),
	));

test("missing text provides nearby context and whitespace guidance for the failing batch index", () =>
	fixture("first\nfunction target() {\n\treturn 42;\n}\n", (cwd, path) =>
		Effect.gen(function* () {
			const before = readFileSync(path);
			yield* Effect.promise(() =>
				assert.rejects(
					createDiagnosticEditTool(cwd).execute("test", {
						path,
						edits: [
							{ oldText: "first", newText: "updated" },
							{
								oldText: "function target() {\n  return 24;\n}",
								newText: "replacement",
							},
						],
					}),
					(error) => {
						assert.ok(error instanceof Error);
						assert.match(error.message, /edits\[1\]/);
						assert.match(error.message, /2: "function target/);
						assert.match(error.message, /3:.*\\treturn 42/);
						assert.match(error.message, /whitespace and newlines/);
						return true;
					},
				),
			);
			assert.deepEqual(readFileSync(path), before);
		}),
	));

test("no matching anchor says so and gives a concrete recovery step", () =>
	fixture("unrelated\n", (cwd, path) =>
		Effect.gen(function* () {
			yield* Effect.promise(() =>
				assert.rejects(
					createDiagnosticEditTool(cwd).execute("test", {
						path,
						edits: [{ oldText: "missing", newText: "new" }],
					}),
					/No nearby context found[\s\S]*read[\s\S]*whitespace and newlines/,
				),
			);
			assert.equal(readFileSync(path, "utf8"), "unrelated\n");
		}),
	));

test("large files and long lines keep diagnostics bounded and explicitly truncated", () =>
	fixture(`repeat${"界".repeat(10000)}\n`.repeat(100), (cwd, path) =>
		Effect.gen(function* () {
			const before = readFileSync(path);
			yield* Effect.promise(() =>
				assert.rejects(
					createDiagnosticEditTool(cwd).execute("test", {
						path,
						edits: [{ oldText: "repeat", newText: "new" }],
					}),
					(error) => {
						assert.ok(error instanceof Error);
						assert.ok(Buffer.byteLength(error.message) <= 8192);
						assert.match(error.message, /line truncated/);
						assert.match(error.message, /first 4 locations/);
						return true;
					},
				),
			);
			assert.deepEqual(readFileSync(path), before);
		}),
	));

test("success keeps original-file batch matching, BOM, CRLF and builtin result details", () =>
	fixture("\uFEFFone\r\ntwo\r\n", (cwd, path) =>
		Effect.gen(function* () {
			const result = yield* Effect.promise(() =>
				createDiagnosticEditTool(cwd).execute("test", {
					path,
					edits: [
						{ oldText: "one\n", newText: "two\n" },
						{ oldText: "two\n", newText: "three\n" },
					],
				}),
			);
			assert.equal(readFileSync(path, "utf8"), "\uFEFFtwo\r\nthree\r\n");
			assert.match(
				result.content[0]?.type === "text" ? result.content[0].text : "",
				/Successfully replaced 2 block/,
			);
			assert.ok(
				result.details &&
					typeof result.details === "object" &&
					"diff" in result.details &&
					"patch" in result.details,
			);
		}),
	));

test("cancellation and overlap reject without writes", () =>
	fixture("alpha beta gamma\n", (cwd, path) =>
		Effect.gen(function* () {
			const tool = createDiagnosticEditTool(cwd);
			const input = { path, edits: [{ oldText: "alpha", newText: "changed" }] };
			yield* Effect.promise(() =>
				assert.rejects(
					tool.execute("test", input, AbortSignal.abort()),
					/^Error: Operation aborted$/,
				),
			);
			yield* Effect.promise(() =>
				assert.rejects(
					tool.execute("test", {
						path,
						edits: [
							{ oldText: "alpha beta", newText: "first" },
							{ oldText: "beta gamma", newText: "second" },
						],
					}),
					/overlap/,
				),
			);
			assert.equal(readFileSync(path, "utf8"), "alpha beta gamma\n");
		}),
	));

test("the installed CLI loads the extension and executes its registered edit tool", () =>
	fixture("first\nrepeat\nsecond\nrepeat\n", (cwd, path) =>
		Effect.sync(() => {
			const { spawnSync } = process.getBuiltinModule("node:child_process");
			const { fileURLToPath } = process.getBuiltinModule("node:url");
			const cli = fileURLToPath(
				new URL(
					"../../../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
					import.meta.url,
				),
			);
			const extension = fileURLToPath(
				new URL("./cli-probe.ts", import.meta.url),
			);
			const result = spawnSync(
				process.execPath,
				[
					cli,
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"-e",
					extension,
					"-p",
					"/edit-feedback-probe",
				],
				{
					cwd,
					env: { HOME: cwd, PI_CODING_AGENT_DIR: join(cwd, "agent") },
					encoding: "utf8",
					timeout: 30000,
				},
			);
			assert.equal(result.status, 0, result.stderr);
			assert.match(
				result.stdout + result.stderr,
				/EDIT_FEEDBACK_PROBE:[\s\S]*2: "repeat"[\s\S]*4: "repeat"/,
			);
			assert.equal(
				readFileSync(path, "utf8"),
				"first\nrepeat\nsecond\nrepeat\n",
			);
		}),
	));

test("escaped control characters cannot exceed the diagnostic byte budget", () =>
	fixture(`repeat${"\u0001".repeat(1000)}\n`.repeat(100), (cwd, path) =>
		Effect.gen(function* () {
			yield* Effect.promise(() =>
				assert.rejects(
					createDiagnosticEditTool(cwd).execute("test", {
						path,
						edits: [{ oldText: "repeat", newText: "changed" }],
					}),
					(error) => {
						assert.ok(error instanceof Error);
						assert.ok(Buffer.byteLength(error.message) <= 8192);
						return true;
					},
				),
			);
		}),
	));

test("multiline ambiguity locates whole oldText rather than unrelated first lines", () =>
	fixture(
		`${"start\nother\n".repeat(5)}start\nwanted\nend\nstart\nwanted\nend\n`,
		(cwd, path) =>
			Effect.gen(function* () {
				yield* Effect.promise(() =>
					assert.rejects(
						createDiagnosticEditTool(cwd).execute("test", {
							path,
							edits: [{ oldText: "start\nwanted", newText: "changed" }],
						}),
						/11: "start"[\s\S]*14: "start"/,
					),
				);
			}),
	));

test("queued cancellation waits for the builtin mutation queue and never writes", () =>
	fixture("original\n", (cwd, path) =>
		Effect.gen(function* () {
			const { withFileMutationQueue } = yield* Effect.promise(
				() => import("@earendil-works/pi-coding-agent"),
			);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const locked = withFileMutationQueue(path, () => {
				entered.resolve();
				return release.promise;
			});
			yield* Effect.promise(() => entered.promise);
			const controller = new AbortController();
			const pending = createDiagnosticEditTool(cwd).execute(
				"test",
				{ path, edits: [{ oldText: "original", newText: "changed" }] },
				controller.signal,
			);
			yield* Effect.sleep(20);
			assert.equal(readFileSync(path, "utf8"), "original\n");
			controller.abort();
			release.resolve();
			yield* Effect.promise(() =>
				assert.rejects(pending, /^Error: Operation aborted$/),
			);
			yield* Effect.promise(() => locked);
			assert.equal(readFileSync(path, "utf8"), "original\n");
		}),
	));

test("whitespace matching and unchanged bytes follow the builtin tool exactly", () =>
	fixture("unused\n", (cwd) =>
		Effect.gen(function* () {
			const { createEditTool } = yield* Effect.promise(
				() => import("@earendil-works/pi-coding-agent"),
			);
			const cases = [
				{ text: "\tvalue\n", oldText: "  value", newText: "changed" },
				{ text: "value   \n", oldText: "value\n", newText: "changed\n" },
				{ text: "\uFEFFvalue\r\n", oldText: "value\n", newText: "changed\n" },
				{
					text: "repeat\r\nrepeat\r\n",
					oldText: "repeat\n",
					newText: "changed\n",
				},
			];
			for (const sample of cases) {
				const original = join(cwd, "builtin.txt");
				const wrapped = join(cwd, "wrapped.txt");
				writeFileSync(original, sample.text);
				writeFileSync(wrapped, sample.text);
				const edit = { oldText: sample.oldText, newText: sample.newText };
				const expected = yield* Effect.promise(() =>
					createEditTool(cwd)
						.execute("builtin", { path: original, edits: [edit] })
						.then(
							() => "accepted",
							() => "rejected",
						),
				);
				const actual = yield* Effect.promise(() =>
					createDiagnosticEditTool(cwd)
						.execute("wrapped", { path: wrapped, edits: [edit] })
						.then(
							() => "accepted",
							() => "rejected",
						),
				);
				assert.equal(actual, expected);
				assert.deepEqual(readFileSync(wrapped), readFileSync(original));
			}
		}),
	));
