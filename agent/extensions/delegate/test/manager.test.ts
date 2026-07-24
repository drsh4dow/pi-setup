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
  isStreaming = false;
  disposed = false;
  abortLeavesRunning = false;
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private promptResolve?: () => void;
  private captureStructured: (value: unknown) => void;

  constructor(captureStructured: (value: unknown) => void) {
    this.captureStructured = captureStructured;
  }

  prompt(text: string) {
    this.prompts.push(text);
    this.isStreaming = true;
    return new Promise<void>((resolve) => {
      this.promptResolve = resolve;
    });
  }

  async steer(text: string) {
    this.steering.push(text);
  }

  async abort() {
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
  }

  subscribe(listener: (event: AgentSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentSessionEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

function harness(onSettled?: (snapshot: DelegateSnapshot) => void) {
  const sessions: FakeChild[] = [];
  const shutdown: FakeChild[] = [];
  const requests: DelegateRequest[] = [];
  const manager = new DelegateManager({
    onSettled,
    async createSession(request, _model, _thinking, captureStructured) {
      requests.push(request);
      const child = new FakeChild(captureStructured);
      sessions.push(child);
      return child as unknown as ChildSession;
    },
    async shutdownSession(child) {
      const fake = child as unknown as FakeChild;
      fake.disposeNow();
      shutdown.push(fake);
    },
  });
  return { manager, sessions, shutdown, requests };
}

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition did not become true");
}

test("manager caps read concurrency at four and queues the fifth child", async () => {
  const { manager, sessions } = harness();
  const jobs = Array.from({ length: 5 }, (_, index) =>
    manager.spawn({ task: `task ${index}`, ctx: context }),
  );
  await eventually(() => sessions.length === 4);
  assert.equal(manager.list([jobs[4].id])[0].status, "queued");

  sessions[0].finish("first");
  await manager.wait([jobs[0].id]);
  await eventually(() => sessions.length === 5);
  assert.equal(manager.list([jobs[4].id])[0].status, "running");

  for (const session of sessions.slice(1)) session.finish("done");
  await manager.wait(jobs.slice(1).map((job) => job.id));
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
  assert.equal(sessions.length, 4);
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

test("an uncooperative cancelled child is disposed and cannot resume", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({ task: "stuck", ctx: context });
  await eventually(() => sessions.length === 1);
  sessions[0].abortLeavesRunning = true;

  const [cancelled] = await manager.cancel([job.id]);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.resumable, false);
  assert.equal(sessions[0].disposed, true);
  await assert.rejects(manager.send(job.id, "continue"), /no longer resumable/);
  await manager.shutdown();
});

test("send steers a running child and resumes a retained session", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({
    task: "initial",
    background: true,
    ctx: context,
  });
  await eventually(() => sessions.length === 1);
  await manager.send(job.id, "focus here");
  assert.deepEqual(sessions[0].steering, ["focus here"]);

  sessions[0].finish("first answer");
  await manager.wait([job.id]);
  const resumed = await manager.send(job.id, "follow up");
  assert.equal(resumed.status, "running");
  await eventually(() => sessions[0].prompts.length === 2);
  sessions[0].finish("second answer");
  const [result] = await manager.wait([job.id]);
  assert.equal(result.output, "second answer");
  assert.equal(sessions.length, 1);
  await manager.shutdown();
});

test("structured retained sessions capture one result per resumed run", async () => {
  const { manager, sessions } = harness();
  const job = manager.spawn({
    task: "structured",
    schema: { type: "object" },
    ctx: context,
  });
  await eventually(() => sessions.length === 1);
  sessions[0].finish("", { run: 1 });
  const [first] = await manager.wait([job.id]);
  assert.deepEqual(first.structured, { run: 1 });

  await manager.send(job.id, "again");
  await eventually(() => sessions[0].prompts.length === 2);
  sessions[0].finish("", { run: 2 });
  const [second] = await manager.wait([job.id]);
  assert.deepEqual(second.structured, { run: 2 });
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

test("only eight settled sessions remain resumable", async () => {
  const { manager, sessions } = harness();
  const jobs: DelegateSnapshot[] = [];
  for (let index = 0; index < 9; index++) {
    const job = manager.spawn({ task: `task ${index}`, ctx: context });
    jobs.push(job);
    await eventually(() => sessions.length === index + 1);
    sessions[index].finish(`done ${index}`);
    await manager.wait([job.id]);
  }
  await eventually(() => !manager.list([jobs[0].id])[0].resumable);
  assert.equal(manager.list([jobs[8].id])[0].resumable, true);
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

test("workflow rejects forward inputs and parallel writes", async () => {
  const { manager } = harness();
  await assert.rejects(
    runWorkflow(
      manager,
      { stages: [{ tasks: [{ id: "a", task: "a", inputs: ["later"] }] }] },
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
