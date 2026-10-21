import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { BackgroundTerminalDelivery } from "../delivery.ts";
import { NotificationFrames } from "../notifications.ts";
import { Tail } from "../terminal.ts";
import {
  type DeliveryMessage,
  type DeliveryOptions,
  decodeMessage,
  registeredExtension,
  testContext,
} from "./registration.ts";

const { spawnSync } = process.getBuiltinModule("node:child_process");

const context = testContext({
  cwd: process.cwd(),
  hasUI: true,
  isIdle: () => true,
  ui: { setStatus() {} },
});

async function eventually(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- Each check must finish before the next attempt.
    if (await condition()) return;
    // oxlint-disable-next-line no-await-in-loop -- Drive the shared fixture and observe each result before the next step.
    await Effect.runPromise(Effect.sleep(25));
  }

  throw new Error("condition not met within 5 seconds");
}

test("notification framing accepts split valid messages and drops malformed frames", () => {
  const frames = new NotificationFrames();
  assert.deepEqual(frames.append(Buffer.from('"hel')), []);
  assert.deepEqual(frames.append(Buffer.from('lo"\nnot-json\n')), ["hello"]);
  assert.deepEqual(frames.append(Buffer.from(`${"x".repeat(4 * 1024 + 1)}\n"after"\n`)), ["after"]);
});

test("emit-to-pi wakes only the owner while its terminal keeps running", async () => {
  const parentMessages: unknown[] = [];

  const childMessages: Array<DeliveryMessage & { options: DeliveryOptions }> = [];

  const parent = registeredExtension((message) => parentMessages.push(message));

  const child = registeredExtension((message, options) =>
    childMessages.push({ ...message, options }),
  );

  await parent.handlers.get("session_start")?.({}, context);
  await child.handlers.get("session_start")?.({}, context);
  const [start, status] = child.tools;

  try {
    const started = await start.execute(
      "emit",
      {
        command:
          "trap 'exit 23' USR1; emit-to-pi 'PR 42 has new feedback'; while :; do sleep 0.1; done",
        title: "PR watcher",
      },
      undefined,
      undefined,
      context,
    );

    await eventually(() => childMessages.length === 1);
    assert.equal(parentMessages.length, 0);
    assert.equal(childMessages[0].customType, "background-terminal-notification");
    assert.match(childMessages[0].content, /PR 42 has new feedback/);
    assert.deepEqual(childMessages[0].options, {
      deliverAs: "steer",
      triggerTurn: true,
    });
    const running = await status.execute("status", { id: started.details.id });
    assert.match(running.content[0].text, /\[running\]/);
    process.kill(started.details.pid, "SIGUSR1");
    await eventually(() => childMessages.length === 2);
    assert.equal(childMessages[1].customType, "background-terminal-results");
    assert.match(childMessages[1].content, /\[failed\].*exit 23/);
    assert.deepEqual(childMessages[1].options, {
      deliverAs: "steer",
      triggerTurn: true,
    });
    assert.equal(parentMessages.length, 0);
  } finally {
    await child.handlers.get("session_shutdown")?.({}, context);
    await parent.handlers.get("session_shutdown")?.({}, context);
  }
});

test("concurrent emitters preserve every frame", async () => {
  const deliveries: Array<{ content: string }> = [];

  const registration = registeredExtension((message) => deliveries.push(message));

  await registration.handlers.get("session_start")?.({}, context);
  const [start] = registration.tools;

  try {
    await start.execute(
      "emit-many",
      {
        command: "for i in $(seq 1 20); do emit-to-pi frame-$i & done; wait; sleep 30",
        title: "concurrent watcher",
      },
      undefined,
      undefined,
      context,
    );

    await eventually(() =>
      Array.from({ length: 20 }, (_, index) => `frame-${index + 1}`).every((frame) =>
        deliveries.some(({ content }) => content.split(/\r?\n/u).includes(frame)),
      ),
    );
  } finally {
    await registration.handlers.get("session_shutdown")?.({}, context);
  }
});

test("a completion carries its terminal's held notifications, and other notifications go alone", () => {
  const messages: DeliveryMessage[] = [];

  const delivery = new BackgroundTerminalDelivery({
    sendMessage(message) {
      messages.push(decodeMessage(message));
    },
  });

  try {
    delivery.setContext({ ...context, isIdle: () => false });
    delivery.enqueueNotification({
      id: "bt-1:notification-1",
      terminalId: "bt-1",
      title: "finished watcher",
      message: "sent before the end",
    });
    delivery.enqueueNotification({
      id: "bt-2:notification-2",
      terminalId: "bt-2",
      title: "running watcher",
      message: "still running",
    });
    assert.equal(messages.length, 0);

    delivery.enqueue({
      id: "bt-1",
      title: "finished watcher",
      command: "watch",
      cwd: "/project",
      state: "done",
      createdAt: 0,
      settledAt: 1_000,
      result: { kind: "success" },
      stdout: new Tail().view(),
      stderr: new Tail().view(),
    });

    const notification = messages.find(
      (message) => message.customType === "background-terminal-notification",
    );

    const results = messages.find(
      (message) => message.customType === "background-terminal-results",
    );

    assert.equal(messages.length, 2);
    assert.match(
      results?.content ?? "",
      /bt-1 \[done\] finished watcher .*\nnotifications sent before it ended:\nsent before the end/,
    );
    assert.doesNotMatch(results?.content ?? "", /still running/);
    assert.match(notification?.content ?? "", /bt-2 \[running\] running watcher\nstill running/);
    assert.doesNotMatch(notification?.content ?? "", /sent before the end/);
  } finally {
    delivery.clear();
  }
});

test("a bg_kill result gives codemode the killed terminal's unread notification", async () => {
  const registration = registeredExtension();
  const busy = { ...context, isIdle: () => false };
  await registration.handlers.get("session_start")?.({}, busy);
  const [start, status, , kill] = registration.tools;

  try {
    const started = await start.execute(
      "watch",
      { command: "emit-to-pi 'server ready'; echo emitted; sleep 30", title: "watcher" },
      undefined,
      undefined,
      busy,
    );

    const emitToPiReturned = async () => {
      const running = await status.execute("status", { id: started.details.id });

      return running.details.stdoutBytes > 0;
    };

    await eventually(emitToPiReturned);

    const killed = await kill.execute("kill", { ids: [started.details.id] });
    assert.deepEqual(killed.structuredContent.results[0].notifications, ["server ready"]);
    assert.match(killed.content[0].text, /notifications sent before it ended:\nserver ready/);
  } finally {
    await registration.handlers.get("session_shutdown")?.({}, context);
  }
});

test("emit-to-pi fails outside an owned background terminal", () => {
  const cli = new URL("../../../../.build/bin/emit-to-pi", import.meta.url);
  const env = { ...process.env };
  delete env.PI_BACKGROUND_TERMINAL_NOTIFY_FD;

  const result = spawnSync(fileURLToPath(cli), ["hello"], {
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pi-owned background terminal/);
});
