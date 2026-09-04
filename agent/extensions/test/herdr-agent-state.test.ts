import assert from "node:assert/strict";
import test from "node:test";

const { spawnSync } = process.getBuiltinModule("node:child_process");
const extensionUrl = new URL("../herdr-agent-state.ts", import.meta.url);

function runScenario(script: string) {
	const harnessUrl = new URL("./fixtures/herdr-harness.mjs", import.meta.url);
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { run } from ${JSON.stringify(harnessUrl.href)};
await run(async ({ ctx, emit, events, eventually, reports, states, setIdle, respondWith }) => {
${script}
});`,
		],
		{ encoding: "utf8", timeout: 15_000 },
	);
	assert.equal(result.status, 0, result.stderr);
}

test("reconciles a finished turn while a background process remains alive", () => {
	runScenario(`
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
try {
  await emit("session_start");
  await eventually(() => states().at(-1)?.params.state === "idle", "initial idle");
  setIdle(false);
  await emit("agent_start");
  await eventually(() => states().at(-1)?.params.state === "working", "working");
  // Reproduce a missed settlement report without terminating session-owned work.
  setIdle(true);
  await eventually(() => states().at(-1)?.params.state === "idle", "finished turn must become idle");
  process.kill(child.pid, 0);
} finally {
  child.kill();
}
`);
});

test("retries a failed idle report without another lifecycle event", () => {
	runScenario(`
let idleAttempts = 0;
let accepted = false;
respondWith((request) => {
  if (request.method === "pane.report_agent" && request.params.state === "idle") {
    idleAttempts++;
    if (idleAttempts <= 2) return undefined;
    accepted = true;
  }
  return { id: request.id, result: {} };
});
await emit("session_start");
await eventually(() => accepted, "idle must be retried after both immediate attempts fail");
`);
});

test("retries rejected idle reports instead of treating socket data as success", () => {
	runScenario(`
let idleAttempts = 0;
let accepted = false;
respondWith((request) => {
  if (request.method === "pane.report_agent" && request.params.state === "idle") {
    idleAttempts++;
    if (idleAttempts <= 2) return { id: request.id, error: { code: "busy", message: "try again" } };
    accepted = true;
  }
  return { id: request.id, result: {} };
});
await emit("session_start");
await eventually(() => accepted, "an error reply must not acknowledge idle");
`);
});

test("preserves busy continuations and blocked precedence, then stops on shutdown", () => {
	runScenario(`
setIdle(false);
await emit("session_start");
await eventually(() => states().at(-1)?.params.state === "working", "working");
await emit("agent_settled");
await delay(1150);
assert.equal(states().at(-1).params.state, "working", "a queued continuation is still busy");
events.get("herdr:blocked")({ active: true, label: "Approval" });
await eventually(() => states().at(-1)?.params.state === "blocked", "blocked");
setIdle(true);
await delay(1150);
assert.equal(states().at(-1).params.state, "blocked", "blocked wins over idle");
assert.equal(states().at(-1).params.message, "Approval");
events.get("herdr:blocked")({ active: false });
await eventually(() => states().at(-1)?.params.state === "idle", "unblocked idle");
await emit("session_shutdown");
const count = reports.length;
ctx.isIdle = () => { throw new Error("stale context accessed"); };
await delay(1150);
assert.equal(reports.length, count, "shutdown must stop reconciliation");
`);
});

test("headless sessions cannot report into their parent's pane", () => {
	runScenario(`
for (const mode of ["rpc", "json", "print"]) {
  const headless = { ...ctx, mode, hasUI: true };
  await emit("session_start", headless);
  setIdle(false);
  await emit("agent_start", headless);
  await emit("agent_settled", headless);
  events.get("herdr:blocked")({ active: true });
}
await delay(1150);
assert.equal(reports.length, 0);
`);
});

test("a newer working state supersedes a failed idle delivery", () => {
	runScenario(`
let idleAttempts = 0;
respondWith((request) => {
  if (request.method === "pane.report_agent" && request.params.state === "idle") {
    idleAttempts++;
    return undefined;
  }
  return { id: request.id, result: {} };
});
await emit("session_start");
await eventually(() => idleAttempts >= 2, "idle attempts fail");
setIdle(false);
await emit("agent_start");
await eventually(() => states().at(-1)?.params.state === "working", "new working state");
const count = states().length;
await delay(1150);
assert.equal(states().length, count, "must not retry superseded idle");
assert.equal(states().at(-1).params.state, "working");
`);
});

test("session-identity errors do not prevent lifecycle state delivery", () => {
	runScenario(`
respondWith((request) => request.method === "pane.report_agent_session"
  ? { id: request.id, error: { code: "unavailable", message: "identity unavailable" } }
  : { id: request.id, result: {} });
await emit("session_start");
await eventually(() => states().at(-1)?.params.state === "idle", "state must not wait for identity success");
assert.equal(states().at(-1).params.agent_session_path, "/tmp/herdr-test-session.jsonl");
`);
});

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
			timeout: 10_000,
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
