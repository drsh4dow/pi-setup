import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  BackgroundTerminalDelivery,
  formatTerminalReport,
  MAX_QUEUED_PER_KIND,
} from "../delivery.ts";
import { type SettledTerminalSnapshot, Tail } from "../terminal.ts";
import { type DeliveryMessage, decodeMessage, testContext } from "./registration.ts";

function snapshot(stdout: string, stderr = ""): SettledTerminalSnapshot {
  const out = new Tail();
  const err = new Tail();
  out.append(Buffer.from(stdout));
  err.append(Buffer.from(stderr));

  return {
    id: "bt-1",
    title: "repository scout",
    command: "pi --print <<'PROMPT'\nRead the repository.\nPROMPT",
    cwd: "/project",
    state: "done",
    createdAt: 0,
    settledAt: 1_000,
    result: { kind: "success" },
    stdout: out.view(),
    stderr: err.view(),
  };
}

function completion(terminal: SettledTerminalSnapshot): string {
  const messages: string[] = [];

  const delivery = new BackgroundTerminalDelivery({
    sendMessage(message) {
      messages.push(decodeMessage(message).content);
    },
  });

  try {
    delivery.setContext(testContext({ isIdle: () => false }));
    delivery.enqueue(terminal);
    assert.equal(messages.length, 1);

    return messages[0];
  } finally {
    delivery.clear();
  }
}

test("splits queued completions into bounded batches without losing results", () => {
  const messages: DeliveryMessage[] = [];

  const terminal: SettledTerminalSnapshot = {
    ...snapshot("é".repeat(20_000), "é".repeat(20_000)),
    id: "bt-0",
    title: "x".repeat(80),
    cwd: `/${"w".repeat(4_094)}`,
    state: "failed",
    result: {
      kind: "error",
      error: "e".repeat(4_096),
      exit: { kind: "unknown" },
    },
  };

  const delivery = new BackgroundTerminalDelivery({
    sendMessage(message) {
      messages.push(decodeMessage(message));

      // Completions arriving during delivery must wait for the next batch.
      if (messages.length === 1)
        for (let index = 1; index < MAX_QUEUED_PER_KIND; index++)
          delivery.enqueue({ ...terminal, id: `bt-${index}` });
    },
  });

  try {
    delivery.setContext(testContext({ isIdle: () => false }));
    delivery.enqueue(terminal);
    const batches = messages.slice(1);
    assert.ok(batches.length > 1, "queued results must span multiple batches");
    assert.ok(batches.some((message) => message.details.ids.length > 1));
    assert.ok(messages.every((message) => Buffer.byteLength(message.content) <= 256 * 1024));
    assert.deepEqual(
      messages.flatMap((message) => message.details.ids),
      Array.from({ length: MAX_QUEUED_PER_KIND }, (_, index) => `bt-${index}`),
    );
    assert.ok(messages.every((message) => !message.content.includes("�")));
  } finally {
    delivery.clear();
  }
});

test("a completion too large to carry its notifications sends them first and keeps its output", () => {
  const messages: DeliveryMessage[] = [];

  const delivery = new BackgroundTerminalDelivery({
    sendMessage(message) {
      messages.push(decodeMessage(message));
    },
  });

  // Each control character renders as a 3-byte replacement, so the notifications
  // outgrow one batch together but each fits alone.
  const notificationIds = Array.from(
    { length: MAX_QUEUED_PER_KIND },
    (_, index) => `bt-1:notification-${index}`,
  );

  try {
    delivery.setContext(testContext({ isIdle: () => false }));

    for (const id of notificationIds)
      delivery.enqueueNotification({
        id,
        terminalId: "bt-1",
        title: "repository scout",
        message: "\x01".repeat(4_000),
      });

    delivery.enqueue(snapshot("scout report"));

    const results = messages.filter(
      (message) => message.customType === "background-terminal-results",
    );

    assert.equal(results.length, 1);
    assert.match(results[0].content, /scout report/);
    assert.equal(
      messages.at(-1)?.customType,
      "background-terminal-results",
      "every notification message comes before the results",
    );
    assert.deepEqual(
      messages.flatMap((message) => message.details.ids).toSorted(),
      [...notificationIds, "bt-1"].toSorted(),
    );

    for (const message of messages.slice(0, -1))
      assert.match(message.content, /^\[Background terminal notifications\]\n\nbt-1 \[done\] /);
  } finally {
    delivery.clear();
  }
});

test("a notification left behind when bg_status takes its terminal's completion names the end state", () => {
  const messages: DeliveryMessage[] = [];
  const errors: string[] = [];
  let sendFails = false;

  const delivery = new BackgroundTerminalDelivery(
    {
      sendMessage(message) {
        if (sendFails) throw new Error("send failed");
        messages.push(decodeMessage(message));
      },
    },
    (error) => errors.push(error),
  );

  try {
    delivery.setContext(testContext({ isIdle: () => false }));
    delivery.enqueueNotification({
      id: "bt-1:notification-1",
      terminalId: "bt-1",
      title: "repository scout",
      message: "halfway",
    });

    sendFails = true;
    delivery.enqueue(snapshot("scout report"));
    assert.equal(errors.length, 1, "the failed send leaves the batch pending");

    delivery.consume(["bt-1"]);
    sendFails = false;
    Effect.runSync(delivery.flush);

    assert.equal(messages.length, 1);
    assert.equal(
      messages[0].content,
      "[Background terminal notifications]\n\nbt-1 [done] repository scout\nhalfway",
    );
  } finally {
    delivery.clear();
  }
});

test("completion preserves a report beyond the old byte and line limits without repeating the command", () => {
  const report = Array.from(
    { length: 120 },
    (_, index) => `Finding ${index}: representative source evidence for the scout.`,
  ).join("\n");

  const terminal = snapshot(report);
  const message = completion(terminal);

  assert.ok(message.includes(report));
  assert.match(message, /bt-1 \[done\] repository scout · exit 0 · 1s/);
  assert.doesNotMatch(message, /command:|cwd:|abbreviated|discarded/);

  const details = formatTerminalReport(terminal);
  assert.match(details, /command: pi --print/);
  assert.match(details, /cwd: \/project/);
});

test("completion distinguishes display abbreviation from retention loss and shares its output budget", () => {
  const terminal = snapshot("é".repeat(140_000), "warning\n".repeat(3_000));
  const message = completion(terminal);

  assert.match(message, /stdout \(17856 earlier bytes discarded by retention\)/);
  assert.match(message, /stdout display abbreviated: \d+ retained bytes not shown/);
  assert.match(message, /stderr display abbreviated: \d+ retained bytes not shown/);
  assert.match(message, /Use bg_status bt-1 for more retained output/);
  assert.doesNotMatch(message, /�/);

  const stdout = message
    .split("\nstdout (17856 earlier bytes discarded by retention):\n")[1]
    .split("\nstdout display abbreviated:")[0];

  const stderr = message.split("\nstderr:\n")[1].split("\nstderr display abbreviated:")[0];

  assert.equal(Buffer.byteLength(stdout) + Buffer.byteLength(stderr), 24 * 1024);

  const details = formatTerminalReport(terminal);
  assert.ok(details.length > message.length);
  assert.match(details, /17856 earlier bytes discarded by retention/);
  assert.match(details, /stdout display abbreviated:/);
});
