import assert from "node:assert/strict";
import test from "node:test";
import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createEventBus as eventBus } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TerminalSnapshot } from "../../background-terminals/terminal.ts";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";
import extension from "../index.ts";
import {
	processStatusSummary,
	processStatusView,
	registerBackgroundTerminalStatus,
} from "../status.ts";

test("collects across independently loaded extension modules", () => {
	const { spawnSync } = process.getBuiltinModule("node:child_process");

	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { createEventBus } from "@earendil-works/pi-coding-agent";
const path = ${JSON.stringify(new URL("../status.ts", import.meta.url).pathname)};
const source = await createJiti(import.meta.url, { moduleCache: false }).import(path);
const consumer = await createJiti(import.meta.url, { moduleCache: false }).import(path);
const events = createEventBus();
source.registerBackgroundTerminalStatus({ events }, {
  list: () => [{
    id: "t1", title: "watcher", command: "watch", cwd: "/", createdAt: 0,
    state: "running", process: { kind: "executing" },
    stdout: { totalBytes: 0, truncatedBytes: 0 },
    stderr: { totalBytes: 0, truncatedBytes: 0 },
  }],
  get: () => undefined,
});
assert.equal(consumer.processStatusSummary({ events }), "1 bg");
assert.match(consumer.processStatusView({ events }).collapsed, /^t1 \\[running\\] watcher/);
`,
		],
		{ encoding: "utf8", timeout: 30_000 },
	);

	assert.equal(result.status, 0, result.stderr);
});

function terminal(
	id: string,
	active: boolean,
	title: string,
	output = "",
): TerminalSnapshot {
	const base = {
		id,
		title,
		command: "watch",
		cwd: "/",
		createdAt: 0,
		stdout: {
			text: output,
			totalBytes: Buffer.byteLength(output),
			truncatedBytes: 0,
		},
		stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
	};

	return active
		? { ...base, state: "running", process: { kind: "executing" } }
		: { ...base, state: "done", settledAt: 1000, result: { kind: "success" } };
}

function registerTerminals(
	events: ExtensionAPI["events"],
	...terminals: TerminalSnapshot[]
) {
	registerBackgroundTerminalStatus(
		{ events },
		{
			list: () => terminals,
			get: (id) => terminals.find((entry) => entry.id === id),
		},
	);
}

test("summarizes active background terminals", () => {
	const events = eventBus();
	registerTerminals(
		events,
		terminal("t1", true, "first"),
		terminal("t2", true, "second"),
		terminal("t3", false, "done"),
	);
	assert.equal(processStatusSummary({ events }), "2 bg");
	assert.equal(processStatusSummary({ events: eventBus() }), undefined);
});

test("lists active terminals collapsed and retained terminals expanded", () => {
	const events = eventBus();
	registerTerminals(
		events,
		terminal("t1", true, "test watcher"),
		terminal("t2", false, "build"),
	);
	const view = processStatusView({ events });
	assert.match(view.collapsed, /^t1 \[running\] test watcher/);
	assert.doesNotMatch(view.collapsed, /t2/);
	assert.match(
		view.expanded,
		/t1 \[running\] test watcher[^\n]*\nt2 \[done\] build/,
	);
	assert.deepEqual(processStatusView({ events: eventBus() }), {
		collapsed: "idle",
		expanded: "idle",
		list: true,
	});
});

test("renders bounded terminal details without control characters", () => {
	const events = eventBus();
	registerTerminals(events, {
		...terminal(
			"t1",
			true,
			"\u001b\u0080\u009f\u202ewatcher",
			"output\t\u0080\ntail",
		),
		command: "é".repeat(40_000),
	});
	const view = processStatusView({ events }, "t1");
	assert.equal(view.collapsed, view.expanded);
	assert.match(view.collapsed, /^t1 \[running\] ����watcher/);
	assert.match(view.collapsed, /\[truncated\][\s\S]*output\t�\ntail$/);
	assert.ok(Buffer.byteLength(view.collapsed) <= 64 * 1024 + 100);
	assert.equal(view.collapsed.match(/�/g)?.length, 5);
});

test("reports unknown terminal ids", () => {
	assert.equal(
		processStatusView({ events: eventBus() }, "missing").collapsed,
		"error: unknown-id · id: missing · action: /ps",
	);
});

test("renders terminal lists and cleans up its status", async () => {
	const events = eventBus();
	registerTerminals(
		events,
		terminal("t1", true, "test watcher", "output\nline"),
		terminal("t2", false, "x".repeat(80)),
	);

	let handler:
		| Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
		| undefined;

	let renderer: EntryRenderer | undefined;
	const adapter = extensionTestAdapter();
	const appended: unknown[] = [];
	const statuses: (string | undefined)[] = [];

	extension(
		unsafeFixture<ExtensionAPI>({
			...adapter.api,
			events,
			appendEntry(_type, data) {
				appended.push(data);
			},
			registerEntryRenderer(_type, value) {
				// SAFETY: The extension appends and renders the same custom entry type; the SDK erases that association in its generic registry.
				renderer = value as EntryRenderer;
			},
			registerTool() {},
			registerCommand(_name, command) {
				handler = command.handler;
			},
		}),
	);

	const context = unsafeFixture<ExtensionContext>({
		mode: "tui",
		hasUI: true,
		ui: unsafeFixture<ExtensionContext["ui"]>({
			setStatus(_name, value) {
				statuses.push(value);
			},
		}),
	});

	await adapter.emit(
		"session_start",
		{ type: "session_start", reason: "startup" },
		context,
	);
	assert.equal(statuses.at(-1), "1 bg");
	assert.ok(handler);

	const commandContext = unsafeFixture<ExtensionCommandContext>({
		mode: "tui",
		hasUI: true,
	});

	await handler("", commandContext);
	await handler("t1", commandContext);
	assert.equal(appended.length, 2);
	assert.ok(renderer);

	const theme = unsafeFixture<Parameters<EntryRenderer>[2]>({
		bg: (_color, text) => text,
		fg: (_color, text) => text,
	});

	const collapsed = renderer(
		unsafeFixture<Parameters<EntryRenderer>[0]>({ data: appended[0] }),
		{ expanded: false },
		theme,
	)?.render(35);

	assert.ok(collapsed?.every((line) => visibleWidth(line) <= 35));
	assert.doesNotMatch(collapsed?.join("\n") ?? "", /t2/);

	const expanded = renderer(
		unsafeFixture<Parameters<EntryRenderer>[0]>({ data: appended[0] }),
		{ expanded: true },
		theme,
	)?.render(35);

	assert.match(expanded?.join("\n") ?? "", /t2 \[done\].*\.\.\./);

	const detail = renderer(
		unsafeFixture<Parameters<EntryRenderer>[0]>({ data: appended[1] }),
		{ expanded: false },
		theme,
	)?.render(80);

	assert.match(detail?.join("\n") ?? "", /output[\s\S]*line/);
	await adapter.emit(
		"session_shutdown",
		{ type: "session_shutdown", reason: "quit" },
		context,
	);
	assert.equal(statuses.at(-1), undefined);
});
