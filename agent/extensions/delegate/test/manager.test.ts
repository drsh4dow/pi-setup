import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  AgentSessionEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type DelegateSnapshot, MAX_CHILD_OUTPUT_BYTES } from "../contract.ts";
import { DelegateManager, type DelegateRequest } from "../manager.ts";
import type { ChildSession } from "../runtime.ts";
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

  emitAssistantStart() {
    this.emit({
      type: "message_start",
      message: { role: "assistant", content: [] },
    } as unknown as AgentSessionEvent);
  }

  emitAssistant(
    output: string,
    totalTokens: number,
    stopReason: "stop" | "toolUse" = "toolUse",
  ) {
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: output }],
        stopReason,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens,
          cost: { total: 0.001 },
        },
      },
    } as AgentSessionEvent);
  }

  finishWithoutResponse() {
    this.isStreaming = false;
    this.promptResolve?.();
    this.promptResolve = undefined;
    this.promptReject = undefined;
  }

  finish(output: string, totalTokens = 15) {
    this.emitAssistant(output, totalTokens, "stop");
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
    async createSession(request) {
      requests.push(request);
      const child = new FakeChild();
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

test("starts every run immediately without aggregate scheduling", async () => {
  const { manager, sessions } = harness();
  const jobs = Array.from({ length: 40 }, (_, index) =>
    manager.spawn({ task: `parallel task ${index}`, ctx: context }),
  );
  await eventually(() => sessions.length === jobs.length);
  assert.ok(manager.list().every((snapshot) => snapshot.status === "running"));

  await manager.cancel(jobs.map((job) => job.id));
  await manager.shutdown();
});

test("the universal ceiling owns a child created after settlement", async (t) => {
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

  t.mock.timers.tick(60 * 60_000);
  const [failed] = await manager.wait([job.id]);
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /60 minutes of wall time/);

  const child = new FakeChild();
  resolveCreation(child as unknown as ChildSession);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(child.disposed, true);
  assert.deepEqual(child.prompts, []);
  await manager.shutdown();
});

test("a stalled provider runs until the universal ceiling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "provider stalls", ctx: context });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessions.length, 1);

  t.mock.timers.tick(59 * 60_000);
  assert.equal(manager.list([job.id])[0].status, "running");
  t.mock.timers.tick(60_000);
  const [failed] = await manager.wait([job.id]);
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /60 minutes of wall time/);
  await eventually(() => sessions[0].disposed);
  await manager.shutdown();
});

test("prompt completion without an assistant response is an error", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "empty provider response", ctx: context });
  await eventually(() => sessions.length === 1);
  sessions[0].finishWithoutResponse();

  const [failed] = await manager.wait([job.id]);
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /without an assistant response.*Retry/);
  await manager.shutdown();
});

test("all effort modes stop at the same sixty-minute ceiling", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const { manager, sessions } = harness();
  const jobs = [
    manager.spawn({ task: "bounded fast task", ctx: context }),
    manager.spawn({
      task: "bounded thorough task",
      effort: "thorough",
      ctx: context,
    }),
  ];
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const session of sessions) session.emitAssistantStart();

  t.mock.timers.tick(59 * 60_000);
  assert.equal(
    manager
      .list(jobs.map((job) => job.id))
      .every((job) => job.status === "running"),
    true,
  );
  t.mock.timers.tick(60_000);
  const stopped = await manager.wait(jobs.map((job) => job.id));
  assert.equal(
    stopped.every((job) => job.status === "error"),
    true,
  );
  assert.equal(
    stopped.every((job) => /60 minutes of wall time/.test(job.error ?? "")),
    true,
  );
  assert.equal(
    sessions.every((session) => session.disposed),
    true,
  );
  await manager.shutdown();
});

test("all effort modes stop at sixty million reported tokens", async () => {
  const requests = [
    { task: "fast token-heavy task", ctx: context },
    {
      task: "thorough token-heavy task",
      effort: "thorough",
      ctx: context,
    },
  ] as const;

  for (const request of requests) {
    const { manager, sessions } = harness();
    const job = manager.spawn(request);
    await eventually(() => sessions.length === 1);

    sessions[0].emitAssistant("checkpoint", 59_999_999);
    assert.equal(manager.list([job.id])[0].status, "running");
    assert.equal(sessions[0].steeringStarted.length, 0);

    sessions[0].emitAssistant("hard checkpoint", 1);
    const [stopped] = await manager.wait([job.id]);
    assert.equal(stopped.status, "error");
    assert.equal(stopped.output, "hard checkpoint");
    assert.equal(stopped.childUsage.totalTokens, 60_000_000);
    assert.match(stopped.error ?? "", /60,000,000 reported tokens/);
    assert.equal(sessions[0].disposed, true);
    await manager.shutdown();
  }
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
        cost: { total: 0.0123 },
      },
    },
  } as AgentSessionEvent);
  assert.deepEqual(manager.sessionUsage(), { tokens: 3, cost: 0.0123 });
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
  await eventually(() => sessions.length === 1);

  await manager.send(running.id, "focus here");
  assert.deepEqual(sessions[0].steering, ["focus here"]);
  sessions[0].finish("done");
  await manager.wait([running.id]);
  await assert.rejects(
    manager.send(running.id, "late"),
    /send requires a running child/,
  );
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

test("stalled steering remains owned until the universal ceiling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "timed steering", ctx: context });
  await new Promise<void>((resolve) => setImmediate(resolve));
  sessions[0].emitAssistantStart();
  sessions[0].steerGate = new Promise<void>(() => {});
  const sending = manager.send(job.id, "stalled");
  await new Promise<void>((resolve) => setImmediate(resolve));

  t.mock.timers.tick(59 * 60_000);
  assert.equal(manager.list([job.id])[0].status, "running");
  t.mock.timers.tick(60_000);
  await assert.rejects(sending, /60 minutes of wall time/);
  const [stopped] = await manager.wait([job.id]);
  assert.equal(stopped.status, "error");
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

test("output format guides without enforcing the final response", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({
    task: "collect evidence",
    outputFormat: "Return JSON with a findings array.",
    ctx: context,
  });
  await eventually(() => sessions.length === 1);
  assert.match(sessions[0].prompts[0], /Preferred output format \(advisory\)/);
  assert.match(sessions[0].prompts[0], /Return JSON with a findings array/);
  assert.match(sessions[0].prompts[0], /correct and complete information/);

  sessions[0].finish("The useful evidence does not fit that shape.");
  const [result] = await manager.wait([job.id]);
  assert.equal(result.status, "done");
  assert.equal(result.output, "The useful evidence does not fit that shape.");
  await manager.shutdown();
});

test("archives complete oversized child output until parent shutdown", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "Return a large report.", ctx: context });
  await eventually(() => sessions.length === 1);
  const report = "é".repeat(MAX_CHILD_OUTPUT_BYTES);
  sessions[0].finish(report);

  const [result] = await manager.wait([job.id]);
  assert.equal(result.outputTruncated, true);
  assert.ok(result.fullOutputFile);
  assert.match(result.output, /full output saved to:/);
  assert.equal(await readFile(result.fullOutputFile, "utf8"), report);

  const savedOutput = result.fullOutputFile;
  await manager.shutdown();
  await assert.rejects(readFile(savedOutput, "utf8"), { code: "ENOENT" });
});

test("retains six bounded conversation messages without tool payloads", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "inspect conversation", ctx: context });
  await eventually(() => sessions.length === 1);
  sessions[0].emit({
    type: "message_end",
    message: { role: "user", content: "inspect conversation" },
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
    isError: true,
  } as AgentSessionEvent);
  assert.deepEqual(manager.recentConversation(job.id), []);
  assert.equal(manager.latestProgress(job.id), "tool: read · error");
  assert.doesNotMatch(manager.latestProgress(job.id) ?? "", /src|source/);
  assert.equal(manager.list([job.id])[0].toolCalls, 1);
  assert.equal(manager.list([job.id])[0].failedToolCalls, 1);

  sessions[0].emit({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "reading the source" }],
    },
    assistantMessageEvent: { type: "text_delta", delta: "source" },
  } as AgentSessionEvent);
  assert.deepEqual(manager.recentConversation(job.id), [
    "Assistant (writing)\n\nreading the source",
  ]);

  sessions[0].emitAssistant("first finding", 10);
  sessions[0].emit({
    type: "message_end",
    message: { role: "user", content: "focus on the tests" },
  } as AgentSessionEvent);
  assert.deepEqual(manager.recentConversation(job.id), [
    "Assistant\n\nfirst finding",
    "User\n\nfocus on the tests",
  ]);

  const longMessage = `begin-${"é".repeat(3_000)}-end`;
  sessions[0].emitAssistant(longMessage, 20);
  const bounded = manager.recentConversation(job.id).at(-1) ?? "";
  assert.ok(Buffer.byteLength(bounded) <= 4 * 1024 + 32);
  assert.match(bounded, /^Assistant\n\nbegin-/);
  assert.match(bounded, /\[message truncated\]/);
  assert.match(bounded, /-end$/);
  assert.doesNotMatch(bounded, /�/);

  for (let index = 0; index < 5; index++) {
    sessions[0].emitAssistant(`message ${index}`, 30 + index);
  }
  const conversation = manager.recentConversation(job.id);
  assert.equal(conversation.length, 6);
  assert.match(conversation[0], /^Assistant\n\nbegin-/);
  assert.equal(conversation.at(-1), "Assistant\n\nmessage 4");
  assert.doesNotMatch(
    conversation.join("\n"),
    /inspect conversation|read|source/,
  );

  sessions[0].finish("final answer");
  await manager.wait([job.id]);
  assert.equal(
    manager.recentConversation(job.id).at(-1),
    "Assistant\n\nfinal answer",
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
  const child = new FakeChild();
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
    async createSession() {
      creations++;
      const child = new FakeChild();
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

  const child = new FakeChild();
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
  const child = new FakeChild();
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

test("settled sessions and usage remain for the parent session", async () => {
  const { manager, sessions } = harness();
  for (let index = 0; index < 65; index++) {
    const job = manager.spawn({ task: `task ${index}`, ctx: context });
    await eventually(() => sessions.length === index + 1);
    sessions[index].emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: {
          input: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { total: 0.01 },
        },
      },
    } as AgentSessionEvent);
    sessions[index].finish("done");
    await manager.wait([job.id]);
  }

  assert.equal(manager.list().length, 65);
  assert.equal(manager.sessionUsage().tokens, 65 * 16);
  assert.ok(Math.abs(manager.sessionUsage().cost - 65 * 0.011) < 1e-10);
  await manager.shutdown();
});
