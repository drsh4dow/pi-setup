import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentSessionEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { DelegateSnapshot } from "../contract.ts";
import { workflowDetail } from "../index.ts";
import { DelegateManager, type DelegateRequest } from "../manager.ts";
import type { ChildSession } from "../runtime.ts";
import { runWorkflow } from "../workflow.ts";
import { eventually } from "./eventually.ts";

const context = {
  cwd: process.cwd(),
  model: { provider: "test", id: "model" },
  modelRegistry: {
    find: () => undefined,
    hasConfiguredAuth: () => true,
  },
} as unknown as ExtensionContext;

class FakeChild {
  readonly model = { provider: "test", id: "child" };
  readonly prompts: string[] = [];
  readonly steering: string[] = [];
  readonly steeringStarted: string[] = [];
  isStreaming = false;
  disposed = false;
  abortLeavesRunning = false;
  abortGate?: Promise<void>;
  steerGate?: Promise<void>;
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private promptResolve?: () => void;
  private promptReject?: (error: Error) => void;
  private captureStructured: (value: unknown) => void;

  constructor(captureStructured: (value: unknown) => void) {
    this.captureStructured = captureStructured;
  }

  prompt(text: string) {
    this.prompts.push(text);
    this.isStreaming = true;
    return new Promise<void>((resolve, reject) => {
      this.promptResolve = resolve;
      this.promptReject = reject;
    });
  }

  async steer(text: string) {
    this.steeringStarted.push(text);
    await this.steerGate;
    this.steering.push(text);
  }

  async abort() {
    await this.abortGate;
    if (this.abortLeavesRunning) return;
    this.isStreaming = false;
    this.promptResolve?.();
    this.promptResolve = undefined;
  }

  disposeNow() {
    this.disposed = true;
    this.isStreaming = false;
    this.promptResolve?.();
    this.promptResolve = undefined;
  }

  dispose() {
    this.disposeNow();
  }

  rejectPrompt(error: Error) {
    this.isStreaming = false;
    this.promptReject?.(error);
    this.promptResolve = undefined;
    this.promptReject = undefined;
  }

  finish(output: string, structured?: unknown) {
    if (structured !== undefined) this.captureStructured(structured);
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: output }],
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { total: 0.001 },
        },
      },
    } as AgentSessionEvent);
    this.isStreaming = false;
    this.promptResolve?.();
    this.promptResolve = undefined;
    this.promptReject = undefined;
  }

  subscribe(listener: (event: AgentSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentSessionEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

function harness(
  onSettled?: (snapshot: DelegateSnapshot) => void,
  beforeShutdown?: (child: FakeChild) => Promise<void>,
) {
  const sessions: FakeChild[] = [];
  const shutdown: FakeChild[] = [];
  const requests: DelegateRequest[] = [];
  const manager = new DelegateManager({
    onSettled,
    async createSession(request, _model, _thinking, captureStructured) {
      requests.push(request);
      const child = new FakeChild(captureStructured);
      setImmediate(() => sessions.push(child));
      return child as unknown as ChildSession;
    },
    async shutdownSession(child) {
      const fake = child as unknown as FakeChild;
      await beforeShutdown?.(fake);
      fake.disposeNow();
      shutdown.push(fake);
    },
  });
  return { manager, sessions, shutdown, requests };
}

test("wait admission is atomic, bounded per child, and releases capacity", async () => {
  const { manager, sessions } = harness();
  const first = manager.spawn({ task: "first", ctx: context });
  const second = manager.spawn({ task: "second", ctx: context });
  await eventually(() => sessions.length === 2);
  const waits = Array.from({ length: 4 }, () => manager.wait([first.id]));
  await assert.rejects(manager.wait([first.id, second.id]), /4 pending waits/);
  sessions[0].finish("done");
  await Promise.all(waits);
  const available = manager.wait([first.id, second.id]);
  sessions[1].finish("done");
  await available;
  await manager.shutdown();
});

test("cancelled unresolved creations retain all four run slots", async () => {
  const resolvers: Array<(child: ChildSession) => void> = [];
  let creations = 0;
  const manager = new DelegateManager({
    createSession(_request, _model, _thinking, _captureStructured) {
      creations++;
      return new Promise<ChildSession>((resolve) => {
        resolvers.push((child) => resolve(child));
      });
    },
  });
  const first = Array.from({ length: 4 }, (_, index) =>
    manager.spawn({ task: `hung ${index}`, ctx: context }),
  );
  await eventually(() => creations === 4);
  await manager.cancel(first.map((job) => job.id));
  for (let index = 0; index < 12; index++) {
    const queued = manager.spawn({ task: `queued ${index}`, ctx: context });
    await manager.cancel([queued.id]);
  }
  assert.equal(creations, 4);

  const later = manager.spawn({ task: "later", ctx: context });
  resolvers[0](new FakeChild(() => {}) as unknown as ChildSession);
  await eventually(() => creations === 5);
  for (const resolve of resolvers.slice(1, 4)) {
    resolve(new FakeChild(() => {}) as unknown as ChildSession);
  }
  resolvers[4](new FakeChild(() => {}) as unknown as ChildSession);
  await eventually(() => manager.list([later.id])[0].status === "running");
  await manager.cancel([later.id]);
  await manager.shutdown();
});

test("session creation timeout is inspectable and owns a late child", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveCreation!: (child: ChildSession) => void;
  const manager = new DelegateManager({
    createSession() {
      return new Promise<ChildSession>((resolve) => {
        resolveCreation = resolve;
      });
    },
    async shutdownSession(child) {
      (child as unknown as FakeChild).disposeNow();
    },
  });
  const job = manager.spawn({ task: "creation hangs", ctx: context });
  await new Promise<void>((resolve) => setImmediate(resolve));

  t.mock.timers.tick(30_000);
  const [failed] = await manager.wait([job.id]);
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /session creation timed out/);

  const child = new FakeChild(() => {});
  resolveCreation(child as unknown as ChildSession);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(child.disposed, true);
  assert.deepEqual(child.prompts, []);
  await manager.shutdown();
});

test("cancellation releases prompts that ignore child abort", async () => {
  const { manager, sessions } = harness();
  const jobs = Array.from({ length: 4 }, (_, index) =>
    manager.spawn({ task: `stuck prompt ${index}`, ctx: context }),
  );
  await eventually(() => sessions.length === 4);
  for (const session of sessions) session.abortLeavesRunning = true;
  await manager.cancel(jobs.map((job) => job.id));

  const later = manager.spawn({ task: "later", ctx: context });
  await eventually(() => sessions.length === 5);
  assert.equal(manager.list([later.id])[0].status, "running");
  sessions[4].finish("done");
  await manager.wait([later.id]);
  await manager.shutdown();
});

test("teardown timeout falls back to local disposal and diagnoses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const diagnostics: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => diagnostics.push(String(message));
  const { manager, sessions } = harness(
    undefined,
    () => new Promise<void>(() => {}),
  );
  const job = manager.spawn({ task: "teardown hangs", ctx: context });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessions.length, 1);

  try {
    const cancelling = manager.cancel([job.id]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(16_000);
    const [cancelled] = await cancelling;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(sessions[0].disposed, true);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /delegate-1.*timed out after 16000ms/);
  } finally {
    console.error = originalError;
  }
  await manager.shutdown();
});

test("teardown rejection falls back to local disposal and diagnoses", async () => {
  const diagnostics: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => diagnostics.push(String(message));
  const { manager, sessions } = harness(undefined, async () => {
    throw new Error("shutdown transport failed");
  });
  const job = manager.spawn({ task: "teardown rejects", ctx: context });
  await eventually(() => sessions.length === 1);

  try {
    const [cancelled] = await manager.cancel([job.id]);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(sessions[0].disposed, true);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /delegate-1.*shutdown transport failed/);
  } finally {
    console.error = originalError;
  }
  await manager.shutdown();
});

test("pending teardowns retain all four scheduling slots", async () => {
  const teardownReleases: Array<() => void> = [];
  const { manager, sessions } = harness(
    undefined,
    () =>
      new Promise<void>((resolve) => {
        teardownReleases.push(resolve);
      }),
  );
  const jobs = Array.from({ length: 5 }, (_, index) =>
    manager.spawn({ task: `task ${index}`, ctx: context }),
  );
  await eventually(
    () =>
      sessions.length === 4 &&
      sessions.every((child) => child.prompts.length === 1),
  );
  for (const session of sessions) session.finish("done");
  await manager.wait(jobs.slice(0, 4).map((job) => job.id));
  await eventually(() => teardownReleases.length === 4);

  assert.equal(sessions.length, 4);
  assert.equal(manager.list([jobs[4].id])[0].status, "queued");
  teardownReleases[0]();
  await eventually(() => sessions[4]?.prompts.length === 1);
  assert.equal(manager.list([jobs[4].id])[0].status, "running");

  sessions[4].finish("done");
  await manager.wait([jobs[4].id]);
  for (const release of teardownReleases.slice(1)) release();
  await manager.shutdown();
});

test("manager caps read concurrency at four and queues the fifth child", async () => {
  const { manager, sessions } = harness();
  const jobs = Array.from({ length: 5 }, (_, index) =>
    manager.spawn({ task: `task ${index}`, ctx: context }),
  );
  await eventually(
    () =>
      sessions.length === 4 &&
      sessions.every((child) => child.prompts.length === 1),
  );
  assert.equal(manager.list([jobs[4].id])[0].status, "queued");

  sessions[0].finish("first");
  await manager.wait([jobs[0].id]);
  await eventually(() => sessions[4]?.prompts.length === 1);
  assert.equal(manager.list([jobs[4].id])[0].status, "running");

  for (const session of sessions.slice(1)) session.finish("done");
  await manager.wait(jobs.slice(1).map((job) => job.id));
  await manager.shutdown();
});

test("rejected child prompt settles, remains inspectable, and releases capacity", async () => {
  const { manager, sessions } = harness();
  const failed = manager.spawn({ task: "transport fails", ctx: context });
  await eventually(() => sessions[0]?.prompts.length === 1);
  sessions[0].emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "partial activity" }],
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { total: 0 },
      },
    },
  } as AgentSessionEvent);
  sessions[0].rejectPrompt(new Error("prompt transport rejected"));

  const [snapshot] = await manager.wait([failed.id]);
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.error, "prompt transport rejected");
  assert.equal(snapshot.output, "partial activity");
  assert.equal(manager.list([failed.id])[0].error, "prompt transport rejected");
  await eventually(() => sessions[0].disposed);

  const next = manager.spawn({ task: "capacity is free", ctx: context });
  await eventually(() => sessions[1]?.prompts.length === 1);
  assert.equal(manager.list([next.id])[0].status, "running");
  sessions[1].finish("done");
  await manager.wait([next.id]);
  await manager.shutdown();
});

test("concurrent admission never exceeds active and queued capacity", async () => {
  const { manager, sessions } = harness();
  const attempts = await Promise.allSettled(
    Array.from({ length: 40 }, (_, index) =>
      Promise.resolve().then(() =>
        manager.spawn({ task: `racing task ${index}`, ctx: context }),
      ),
    ),
  );
  const accepted = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" ? [attempt.value] : [],
  );
  assert.equal(accepted.length, 36);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "rejected").length,
    4,
  );
  await eventually(() => sessions.length === 4);
  assert.equal(
    manager.list().filter((snapshot) => snapshot.status === "queued").length,
    32,
  );

  await manager.cancel(accepted.map((snapshot) => snapshot.id));
  await manager.shutdown();
});

test("write jobs run alone and preserve FIFO ordering", async () => {
  const { manager, sessions } = harness();
  const reader = manager.spawn({ task: "read", ctx: context });
  const writer = manager.spawn({
    task: "write",
    workspace: "write",
    ctx: context,
  });
  const laterReader = manager.spawn({ task: "later read", ctx: context });
  await eventually(() => sessions.length === 1);

  sessions[0].finish("read done");
  await manager.wait([reader.id]);
  await eventually(() => sessions.length === 2);
  assert.equal(manager.list([writer.id])[0].status, "running");
  assert.equal(manager.list([laterReader.id])[0].status, "queued");

  sessions[1].finish("write done");
  await manager.wait([writer.id]);
  await eventually(() => sessions.length === 3);
  sessions[2].finish("later done");
  await manager.wait([laterReader.id]);
  await manager.shutdown();
});

test("interrupted waits leave children running and explicit cancel stops them", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "long", ctx: context });
  await eventually(() => sessions.length === 1);
  const controller = new AbortController();
  const waiting = manager.wait([job.id], controller.signal);
  controller.abort(new Error("stop waiting"));
  await assert.rejects(waiting, /stop waiting/);
  assert.equal(manager.list([job.id])[0].status, "running");

  const [cancelled] = await manager.cancel([job.id]);
  assert.equal(cancelled.status, "cancelled");
  await manager.shutdown();
});

test("an interrupted background wait restores delivery for the same run", async () => {
  const delivered: DelegateSnapshot[] = [];
  const { manager, sessions } = harness((snapshot) => delivered.push(snapshot));
  const job = manager.spawn({
    task: "background",
    background: true,
    ctx: context,
  });
  await eventually(() => sessions.length === 1);
  const controller = new AbortController();
  const waiting = manager.wait([job.id], controller.signal);
  controller.abort(new Error("stop waiting"));
  sessions[0].finish("raced result");

  await assert.rejects(waiting, /stop waiting/);
  await eventually(() => delivered.length === 1);
  assert.equal(delivered[0].output, "raced result");
  assert.equal(manager.list([job.id])[0].status, "done");
  await manager.shutdown();
});

test("a successful concurrent wait prevents an aborted wait from restoring delivery", async () => {
  const delivered: DelegateSnapshot[] = [];
  const { manager, sessions } = harness((snapshot) => delivered.push(snapshot));
  const job = manager.spawn({
    task: "background",
    background: true,
    ctx: context,
  });
  await eventually(() => sessions.length === 1);
  const controller = new AbortController();
  const aborted = manager.wait([job.id], controller.signal);
  const successful = manager.wait([job.id]);
  controller.abort(new Error("stop one wait"));
  sessions[0].finish("result");

  await assert.rejects(aborted, /stop one wait/);
  await successful;
  assert.equal(delivered.length, 0);
  await manager.shutdown();
});

test("cancel consumption wins over an aborted concurrent wait", async () => {
  const delivered: DelegateSnapshot[] = [];
  const { manager, sessions } = harness((snapshot) => delivered.push(snapshot));
  const job = manager.spawn({
    task: "background",
    background: true,
    ctx: context,
  });
  await eventually(() => sessions.length === 1);
  let releaseAbort!: () => void;
  sessions[0].abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  const controller = new AbortController();
  const waiting = manager.wait([job.id], controller.signal);
  const cancelling = manager.cancel([job.id]);
  controller.abort(new Error("stop waiting"));
  releaseAbort();

  await assert.rejects(waiting, /stop waiting/);
  const [cancelled] = await cancelling;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(delivered.length, 0);
  await manager.shutdown();
});

test("concurrent shutdown joins gated child disposal", async () => {
  let releaseDisposal!: () => void;
  const disposalGate = new Promise<void>((resolve) => {
    releaseDisposal = resolve;
  });
  let disposalStarted = false;
  const { manager, sessions } = harness(undefined, async () => {
    disposalStarted = true;
    await disposalGate;
  });
  manager.spawn({ task: "shutdown twice", ctx: context });
  await eventually(() => sessions.length === 1);

  let firstSettled = false;
  let secondSettled = false;
  const first = manager.shutdown().finally(() => {
    firstSettled = true;
  });
  const second = manager.shutdown().finally(() => {
    secondSettled = true;
  });
  await eventually(() => disposalStarted);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  releaseDisposal();
  await Promise.all([first, second]);
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);
  await manager.shutdown();
});

test("concurrent cancellation joins the in-progress stop", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "cancel twice", ctx: context });
  await eventually(() => sessions.length === 1);
  let releaseAbort!: () => void;
  sessions[0].abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  const first = manager.cancel([job.id]);
  const second = manager.cancel([job.id]);
  releaseAbort();

  assert.equal((await first)[0].status, "cancelled");
  assert.equal((await second)[0].status, "cancelled");
  await manager.shutdown();
});

test("cancellation waits for an existing child to be disposed", async () => {
  let releaseDisposal!: () => void;
  const disposalGate = new Promise<void>((resolve) => {
    releaseDisposal = resolve;
  });
  let disposalStarted = false;
  const { manager, sessions } = harness(undefined, async () => {
    disposalStarted = true;
    await disposalGate;
  });
  const job = manager.spawn({ task: "cancel and dispose", ctx: context });
  await eventually(() => sessions.length === 1);

  let settled = false;
  const cancelling = manager.cancel([job.id]).finally(() => {
    settled = true;
  });
  await eventually(() => disposalStarted);
  assert.equal(settled, false);
  releaseDisposal();
  assert.equal((await cancelling)[0].status, "cancelled");
  await manager.shutdown();
});

test("an uncooperative cancelled child is disposed", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "stuck", ctx: context });
  await eventually(() => sessions.length === 1);
  sessions[0].abortLeavesRunning = true;

  const [cancelled] = await manager.cancel([job.id]);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(sessions[0].disposed, true);
  await manager.shutdown();
});

test("send steers only a running child", async () => {
  const { manager, sessions } = harness();
  const running = manager.spawn({ task: "running", ctx: context });
  const queued = manager.spawn({
    task: "queued",
    workspace: "write",
    ctx: context,
  });
  await eventually(() => sessions.length === 1);

  await assert.rejects(
    manager.send(queued.id, "steer"),
    /send requires a running child/,
  );
  await manager.send(running.id, "focus here");
  assert.deepEqual(sessions[0].steering, ["focus here"]);
  sessions[0].finish("done");
  await manager.wait([running.id]);
  await assert.rejects(
    manager.send(running.id, "late"),
    /send requires a running child/,
  );

  await manager.cancel([queued.id]);
  await manager.shutdown();
});

test("cancellation settles all gated sends", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "gated steering", ctx: context });
  await eventually(() => sessions.length === 1);
  sessions[0].steerGate = new Promise<void>(() => {});
  const sends = Array.from({ length: 8 }, (_, index) =>
    manager.send(job.id, `message ${index}`),
  );
  const settled = Promise.allSettled(sends);
  await eventually(() => sessions[0].steeringStarted.length === 1);

  await manager.cancel([job.id]);
  const results = await settled;
  assert.equal(
    results.every((result) => result.status === "rejected"),
    true,
  );
  assert.deepEqual(sessions[0].steeringStarted, ["message 0"]);
  await manager.shutdown();
});

test("steering timeout rejects and starts joined cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let releaseDisposal!: () => void;
  const disposalGate = new Promise<void>((resolve) => {
    releaseDisposal = resolve;
  });
  let disposalStarted = false;
  const { manager, sessions } = harness(undefined, async () => {
    disposalStarted = true;
    await disposalGate;
  });
  const job = manager.spawn({ task: "timed steering", ctx: context });
  await new Promise<void>((resolve) => setImmediate(resolve));
  sessions[0].steerGate = new Promise<void>(() => {});
  const sending = manager.send(job.id, "timeout");
  await new Promise<void>((resolve) => setImmediate(resolve));

  t.mock.timers.tick(5_000);
  await assert.rejects(sending, /steering timed out/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposalStarted, true);
  assert.equal(manager.list([job.id])[0].status, "cancelled");
  await assert.rejects(
    manager.send(job.id, "late"),
    /send requires a running child/,
  );
  releaseDisposal();
  await manager.cancel([job.id]);
  await manager.shutdown();
});

test("queued sends do not reach a settled child", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "initial", ctx: context });
  await eventually(() => sessions.length === 1);
  let releaseSteer!: () => void;
  sessions[0].steerGate = new Promise<void>((resolve) => {
    releaseSteer = resolve;
  });
  const first = manager.send(job.id, "first");
  await eventually(() => sessions[0].steeringStarted.length === 1);
  const stale = manager.send(job.id, "stale");
  sessions[0].finish("done");
  await manager.wait([job.id]);
  releaseSteer();

  await assert.rejects(first, /ownership ended/);
  await assert.rejects(stale, /settled before the queued message/);
  assert.deepEqual(sessions[0].steering, ["first"]);
  await manager.shutdown();
});

test("pending sends are capped", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "running", ctx: context });
  await eventually(() => sessions.length === 1);
  let releaseSteer!: () => void;
  sessions[0].steerGate = new Promise<void>((resolve) => {
    releaseSteer = resolve;
  });
  const sends = Array.from({ length: 8 }, (_, index) =>
    manager.send(job.id, `message ${index}`),
  );
  await assert.rejects(manager.send(job.id, "overflow"), /8 pending messages/);
  releaseSteer();
  await Promise.all(sends);
  sessions[0].finish("done");
  await manager.wait([job.id]);
  await manager.shutdown();
});

test("structured output is captured for one child run", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({
    task: "structured",
    schema: { type: "object" },
    ctx: context,
  });
  await eventually(() => sessions.length === 1);
  sessions[0].finish("", { value: 1 });
  const [result] = await manager.wait([job.id]);
  assert.deepEqual(result.structured, { value: 1 });
  await manager.shutdown();
});

test("retains bounded recent messages and tool inputs and outputs", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "inspect activity", ctx: context });
  await eventually(() => sessions.length === 1);
  sessions[0].emit({
    type: "message_end",
    message: { role: "user", content: "inspect activity" },
  } as AgentSessionEvent);
  sessions[0].emit({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    args: { path: "src/a.ts" },
  } as AgentSessionEvent);
  sessions[0].emit({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "source" }] },
    isError: false,
  } as AgentSessionEvent);
  const toolActivity = manager.recentActivity(job.id).join("\n");
  assert.match(toolActivity, /role: user\nmessage:\ninspect activity/);
  assert.match(toolActivity, /path: 'src\/a.ts'/);
  assert.match(
    toolActivity,
    /tool: read[\s\S]*status: running[\s\S]*started: \d{4}-\d{2}-\d{2}T/,
  );
  assert.match(
    toolActivity,
    /tool: read[\s\S]*status: done[\s\S]*duration: \d+ms[\s\S]*output:[\s\S]*source/,
  );
  const workflowActivity = workflowDetail(manager, {
    id: "workflow-1",
    status: "running",
    startedAt: Date.now(),
    stage: "inspect",
    settledTasks: 0,
    totalTasks: 1,
    tasks: [],
    activity: [],
    activeTasks: [
      {
        id: "reader",
        stage: "inspect",
        delegateId: job.id,
        summary: "[running] read",
      },
    ],
  });
  assert.match(
    workflowActivity,
    /activity:[\s\S]*reader:[\s\S]*status: done[\s\S]*source/,
  );
  sessions[0].emit({
    type: "tool_execution_end",
    toolCallId: "wide-result",
    toolName: "wide",
    result: Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`key-${index}`, index]),
    ),
    isError: false,
  } as AgentSessionEvent);
  const wide = manager.recentActivity(job.id).at(-1) ?? "";
  assert.ok(Buffer.byteLength(wide) <= 8 * 1024);
  assert.match(wide, /properties omitted/);
  assert.doesNotMatch(wide, /key-999/);
  const hugeText = "x".repeat(20_000);
  sessions[0].emit({
    type: "tool_execution_end",
    toolCallId: "huge-strings",
    toolName: "wide",
    result: { [hugeText]: new Error(hugeText) },
    isError: true,
  } as AgentSessionEvent);
  const hugeStrings = manager.recentActivity(job.id).at(-1) ?? "";
  assert.ok(Buffer.byteLength(hugeStrings) <= 8 * 1024);
  assert.doesNotMatch(hugeStrings, /x{4_001}/);
  for (let index = 0; index < 30; index++) {
    sessions[0].emit({
      type: "tool_execution_start",
      toolCallId: `extra-${index}`,
      toolName: "read",
      args: { index },
    } as AgentSessionEvent);
  }

  const activity = manager.recentActivity(job.id);
  assert.ok(activity.length <= 24);
  assert.ok(Buffer.byteLength(activity.join("")) <= 32 * 1024);
  assert.doesNotMatch(activity.join("\n"), /inspect activity/);
  assert.match(activity.join("\n"), /index: 29/);

  sessions[0].finish("done");
  await manager.wait([job.id]);
  assert.match(
    manager.recentActivity(job.id).at(-1) ?? "",
    /role: assistant\nmessage:\ndone/,
  );
  await manager.shutdown();
});

test("only unconsumed background runs trigger automatic delivery", async () => {
  const delivered: DelegateSnapshot[] = [];
  const { manager, sessions } = harness((snapshot) => delivered.push(snapshot));
  const automatic = manager.spawn({
    task: "automatic",
    background: true,
    ctx: context,
  });
  await eventually(() => sessions.length === 1);
  sessions[0].finish("delivered");
  await eventually(() => delivered.length === 1);
  assert.equal(delivered[0].id, automatic.id);

  const consumed = manager.spawn({
    task: "consumed",
    background: true,
    ctx: context,
  });
  const waiting = manager.wait([consumed.id]);
  await eventually(() => sessions.length === 2);
  sessions[1].finish("waited");
  await waiting;
  assert.equal(delivered.length, 1);

  const cancelled = manager.spawn({
    task: "cancelled",
    background: true,
    ctx: context,
  });
  await eventually(() => sessions.length === 3);
  await manager.cancel([cancelled.id]);
  assert.equal(delivered.length, 1);
  await manager.shutdown();
});

test("shutdown owns a child created just before its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let resolveCreation!: (child: ChildSession) => void;
  let releaseDisposal!: () => void;
  const disposalGate = new Promise<void>((resolve) => {
    releaseDisposal = resolve;
  });
  let creations = 0;
  let disposals = 0;
  const manager = new DelegateManager({
    createSession() {
      creations++;
      return new Promise<ChildSession>((resolve) => {
        resolveCreation = resolve;
      });
    },
    async shutdownSession(child) {
      disposals++;
      await disposalGate;
      (child as unknown as FakeChild).disposeNow();
    },
  });
  manager.spawn({ task: "late child", ctx: context });
  manager.spawn({ task: "must never start", workspace: "write", ctx: context });
  await new Promise<void>((resolve) => setImmediate(resolve));

  let firstSettled = false;
  let secondSettled = false;
  const firstShutdown = manager.shutdown().finally(() => {
    firstSettled = true;
  });
  const joinedShutdown = manager.shutdown().finally(() => {
    secondSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4_999);
  const child = new FakeChild(() => {});
  resolveCreation(child as unknown as ChildSession);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(disposals, 1);
  assert.deepEqual(child.prompts, []);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  t.mock.timers.tick(1);
  await Promise.all([firstShutdown, joinedShutdown]);
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);

  releaseDisposal();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(child.disposed, true);
  assert.equal(disposals, 1);
  assert.equal(creations, 1);
});

test("shutdown bounds an uncooperative existing child", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let releaseDisposal!: () => void;
  const disposalGate = new Promise<void>((resolve) => {
    releaseDisposal = resolve;
  });
  let creations = 0;
  let disposals = 0;
  const sessions: FakeChild[] = [];
  const manager = new DelegateManager({
    async createSession(_request, _model, _thinking, captureStructured) {
      creations++;
      const child = new FakeChild(captureStructured);
      sessions.push(child);
      return child as unknown as ChildSession;
    },
    async shutdownSession(child) {
      disposals++;
      await disposalGate;
      (child as unknown as FakeChild).disposeNow();
    },
  });
  manager.spawn({ task: "never settles", ctx: context });
  manager.spawn({ task: "must never start", workspace: "write", ctx: context });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessions[0].prompts.length, 1);
  sessions[0].abortGate = new Promise<void>(() => {});

  let firstSettled = false;
  let secondSettled = false;
  const firstShutdown = manager.shutdown().finally(() => {
    firstSettled = true;
  });
  const joinedShutdown = manager.shutdown().finally(() => {
    secondSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4_999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  assert.equal(disposals, 0);

  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);
  assert.equal(disposals, 1);
  assert.equal(creations, 1);

  releaseDisposal();
  await Promise.all([firstShutdown, joinedShutdown]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessions[0].disposed, true);
  assert.equal(disposals, 1);
  assert.equal(creations, 1);
});

test("shutdown returns at its deadline and owns a child arriving later", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let resolveCreation!: (child: ChildSession) => void;
  let creations = 0;
  let disposals = 0;
  const manager = new DelegateManager({
    createSession() {
      creations++;
      return new Promise<ChildSession>((resolve) => {
        resolveCreation = resolve;
      });
    },
    async shutdownSession(child) {
      disposals++;
      (child as unknown as FakeChild).disposeNow();
    },
  });
  manager.spawn({ task: "late child", ctx: context });
  manager.spawn({ task: "must never start", workspace: "write", ctx: context });
  await new Promise<void>((resolve) => setImmediate(resolve));

  let settled = false;
  const firstShutdown = manager.shutdown().finally(() => {
    settled = true;
  });
  const joinedShutdown = manager.shutdown();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  t.mock.timers.tick(4_999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await Promise.all([firstShutdown, joinedShutdown]);
  assert.equal(settled, true);

  const child = new FakeChild(() => {});
  resolveCreation(child as unknown as ChildSession);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(child.disposed, true);
  assert.equal(disposals, 1);
  assert.deepEqual(child.prompts, []);
  assert.equal(creations, 1);
});

test("cancelling during session creation disposes late arrivals", async () => {
  let resolveCreation!: (child: ChildSession) => void;
  const created = new Promise<ChildSession>((resolve) => {
    resolveCreation = resolve;
  });
  const child = new FakeChild(() => {});
  const manager = new DelegateManager({
    createSession: async () => created,
    async shutdownSession(session) {
      (session as unknown as FakeChild).disposed = true;
    },
  });
  const job = manager.spawn({ task: "slow startup", ctx: context });
  const [result] = await manager.cancel([job.id]);
  assert.equal(result.status, "cancelled");

  resolveCreation(child as unknown as ChildSession);
  await eventually(() => child.disposed);
  await manager.shutdown();
});

test("settled sessions are disposed and list keeps active children first", async () => {
  const { manager, sessions } = harness();
  const jobs: DelegateSnapshot[] = [];
  for (let index = 0; index < 3; index++) {
    const job = manager.spawn({ task: `task ${index}`, ctx: context });
    jobs.push(job);
    await eventually(() => sessions.length === index + 1);
    sessions[index].finish(`done ${index}`);
    await manager.wait([job.id]);
    await eventually(() => sessions[index].disposed);
  }

  const active = manager.spawn({ task: "active", ctx: context });
  await eventually(() => sessions.length === 4);
  assert.deepEqual(
    manager.list().map((snapshot) => snapshot.id),
    [active.id, jobs[2].id, jobs[1].id, jobs[0].id],
  );
  await manager.shutdown();
});

test("workflow runs stages in order, fans out, and passes structured inputs", async () => {
  const { manager, sessions } = harness();
  const activeStages: Array<string | undefined> = [];
  const activeTasks: string[][] = [];
  const running = runWorkflow(
    manager,
    {
      stages: [
        {
          name: "scan",
          tasks: [
            {
              id: "a",
              task: "scan a",
              schema: {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
              },
            },
            { id: "b", task: "scan b" },
          ],
        },
        {
          name: "report",
          tasks: [{ id: "report", task: "combine", inputs: ["a", "b"] }],
        },
      ],
    },
    context,
    undefined,
    (progress) => {
      activeStages.push(progress.activeStage);
      activeTasks.push(progress.activeTasks.map((task) => task.snapshot.id));
    },
  );

  await eventually(() => sessions.length === 2);
  sessions[1].finish("result b");
  sessions[0].finish("", { value: 42 });
  await eventually(() => sessions.length === 3);
  assert.match(sessions[2].prompts[0], /## a\n\{"value":42\}/);
  assert.match(sessions[2].prompts[0], /## b\nresult b/);
  sessions[2].finish("combined");

  const result = await running;
  assert.equal(result.success, true);
  assert.equal(result.activeStage, undefined);
  assert.deepEqual(activeStages, ["scan", "scan", "report", "report"]);
  assert.deepEqual(activeTasks, [
    ["delegate-1", "delegate-2"],
    [],
    ["delegate-3"],
    [],
  ]);
  assert.deepEqual(
    result.tasks.map((task) => task.id),
    ["a", "b", "report"],
  );
  await manager.shutdown();
});

test("workflow rejects a singleton before spawning a child", async () => {
  const { manager, sessions } = harness();
  await assert.rejects(
    runWorkflow(
      manager,
      { stages: [{ tasks: [{ id: "only", task: "one task" }] }] },
      context,
    ),
    (error: Error) => {
      assert.equal(
        error.message,
        "A workflow requires at least two tasks; use delegate_run for one task.",
      );
      return true;
    },
  );
  assert.equal(sessions.length, 0);
  await manager.shutdown();
});

test("workflow rejects oversized handoffs instead of truncating JSON", async () => {
  const { manager, sessions } = harness();
  const running = runWorkflow(
    manager,
    {
      stages: [
        {
          tasks: [
            {
              id: "source",
              task: "produce data",
              schema: { type: "object" },
            },
          ],
        },
        {
          tasks: [{ id: "consumer", task: "consume", inputs: ["source"] }],
        },
      ],
    },
    context,
  );

  await eventually(() => sessions.length === 1);
  sessions[0].finish("", { value: "x".repeat(33 * 1024) });
  await assert.rejects(running, /inputs exceed the 32768-byte handoff limit/);
  assert.equal(sessions.length, 1);
  await manager.shutdown();
});

test("workflow rejects same-stage inputs before spawning a child", async () => {
  const { manager, sessions } = harness();
  await assert.rejects(
    runWorkflow(
      manager,
      {
        stages: [
          {
            tasks: [
              { id: "first", task: "first" },
              { id: "second", task: "second", inputs: ["first"] },
            ],
          },
        ],
      },
      context,
    ),
    /must reference an earlier-stage task/,
  );
  assert.equal(sessions.length, 0);
  await manager.shutdown();
});

test("workflow rejects forward inputs and parallel writes", async () => {
  const { manager } = harness();
  await assert.rejects(
    runWorkflow(
      manager,
      {
        stages: [
          {
            tasks: [
              { id: "a", task: "a", inputs: ["later"] },
              { id: "b", task: "b" },
            ],
          },
        ],
      },
      context,
    ),
    /must reference an earlier-stage task/,
  );
  await assert.rejects(
    runWorkflow(
      manager,
      {
        stages: [
          {
            tasks: [
              { id: "write", task: "write", workspace: "write" },
              { id: "read", task: "read" },
            ],
          },
        ],
      },
      context,
    ),
    /write task and must contain no other tasks/,
  );
  await manager.shutdown();
});
