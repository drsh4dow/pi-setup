import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NOTIFICATION_MESSAGE, RESULTS_MESSAGE } from "../delivery.ts";
import type { BackgroundTerminalOptions } from "../index.ts";
import { type DeliveryMessage, registeredExtension, testContext } from "./registration.ts";

async function settleFixture(
  t: TestContext,
  mode: ExtensionContext["mode"],
  options: BackgroundTerminalOptions = {},
) {
  const steered: DeliveryMessage[] = [];
  const { tools, handlers } = registeredExtension((message) => steered.push(message), options);

  const context = testContext({
    cwd: process.cwd(),
    mode,
    hasUI: false,
    isIdle: () => false,
    signal: undefined,
  });

  t.after(() => handlers.get("session_shutdown")?.({}, context));
  await handlers.get("session_start")?.({}, context);

  const [start] = tools;

  return {
    steered,
    start: (command: string) => start.execute("start", { command, title: "settle probe" }),
    settle: () => handlers.beforeSettle(context),
  };
}

test("a print run waits at settle and continues with the finished terminal's result", async (t) => {
  const fixture = await settleFixture(t, "print");
  await fixture.start("sleep 0.2; echo done");

  const result = await fixture.settle();

  assert.ok(result, "settle must continue the run");
  assert.equal(result.entries[0].customType, RESULTS_MESSAGE);
  assert.match(result.entries[0].content, /done/);
  // The settle entry is the only delivery; steering it as well would repeat it.
  assert.deepEqual(fixture.steered, []);
});

test("an interactive session settles without waiting for running terminals", async (t) => {
  const fixture = await settleFixture(t, "tui");
  await fixture.start("sleep 0.2; echo done");

  assert.equal(await fixture.settle(), undefined);
});

test("a subagent's interactive session waits at settle, as a print run does", async (t) => {
  process.env.PI_SUBAGENT_RUN = "/tmp/pi-subagent-settle-probe";
  t.after(() => {
    delete process.env.PI_SUBAGENT_RUN;
  });

  const fixture = await settleFixture(t, "tui");
  await fixture.start("sleep 0.2; echo done");

  const result = await fixture.settle();

  assert.ok(result, "settle must continue the run");
  assert.equal(result.entries[0].customType, RESULTS_MESSAGE);
  assert.match(result.entries[0].content, /done/);
});

test("a print run stops waiting after three idle waits on a terminal that keeps running", async (t) => {
  const fixture = await settleFixture(t, "print", { settleWaitMs: 50 });
  await fixture.start("sleep 10");

  for (let wait = 1; wait <= 3; wait++) {
    // oxlint-disable-next-line no-await-in-loop -- Each settle boundary follows the previous one.
    const result = await fixture.settle();
    assert.ok(result, `idle wait ${wait} must continue the run`);
    assert.equal(result.entries[0].customType, NOTIFICATION_MESSAGE);
    assert.match(result.entries[0].content, /still running[\s\S]*settle probe/);
  }

  assert.equal(await fixture.settle(), undefined);
});
