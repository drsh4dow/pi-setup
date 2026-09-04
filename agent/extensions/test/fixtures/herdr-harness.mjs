import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function run(check) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "herdr-test-"));
	const socketPath = path.join(directory, "herdr.sock");
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "test:p1";
	process.env.HERDR_SOCKET_PATH = socketPath;
	const reports = [];
	const sockets = new Set();
	let respond = (request) => ({ id: request.id, result: {} });
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let input = "";
		socket.on("data", (chunk) => {
			input += chunk;
			if (!input.includes("\n")) return;
			const request = JSON.parse(input.trim());
			reports.push(request);
			const response = respond(request);
			if (response === undefined) socket.destroy();
			else socket.end(`${JSON.stringify(response)}\n`);
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	const hooks = new Map();
	const events = new Map();
	const pi = {
		on(name, handler) {
			hooks.set(name, handler);
		},
		events: {
			on(name, handler) {
				events.set(name, handler);
				return () => events.delete(name);
			},
		},
	};
	let idle = true;
	const ctx = {
		mode: "tui",
		isIdle: () => idle,
		sessionManager: {
			getSessionFile: () => "/tmp/herdr-test-session.jsonl",
			getSessionId: () => "herdr-test-session",
		},
	};
	const emit = async (name, context = ctx) =>
		hooks.get(name)?.({ type: name, reason: "startup" }, context);
	async function eventually(predicate, message) {
		const deadline = Date.now() + 3500;
		while (!predicate() && Date.now() < deadline) await delay(10);
		assert.ok(predicate(), message);
	}
	try {
		const { default: extension } = await import("../../herdr-agent-state.ts");
		extension(pi);
		await check({
			ctx,
			emit,
			events,
			eventually,
			reports,
			states: () => reports.filter((r) => r.method === "pane.report_agent"),
			setIdle: (value) => {
				idle = value;
			},
			respondWith: (handler) => {
				respond = handler;
			},
		});
	} finally {
		await emit("session_shutdown");
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, { recursive: true, force: true });
	}
}
