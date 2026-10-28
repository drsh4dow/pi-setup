import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnGuard } from "../../../agent/extensions/delegate-guard.ts";
import { ARMS } from "../arms.ts";
import { type Settings, workerArgs } from "../launch.ts";
import { scenarios } from "../scenarios.ts";

const HARNESS = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

const settings: Settings = {
  harness: HARNESS,
  harnessHead: "HEAD",
  thinking: "medium",
  timeoutMinutes: undefined,
  latencySeconds: 0,
  parentModel: "anthropic/claude-opus-5-5",
  parentThinking: "medium",
  askTimeoutMinutes: 10,
};

const scenario = scenarios[0];

for (const arm of Object.values(ARMS)) {
  test(`a worker of arm ${arm.id} runs as a delegate and may spawn nothing`, () => {
    assert.ok(scenario, "the eval defines a scenario");

    const run = { scenario, arm, model: "anthropic/claude-opus-5-5", trial: 1, dir: "/w" };

    for (const resume of [null, "session-1"]) {
      const args = workerArgs(
        run,
        settings,
        { prompt: "Do the brief.", trigger: "brief", resume },
        "/s",
      );

      const guard = spawnGuard(["node", "pi", ...args]);

      assert.ok(guard, `arm ${arm.id} (resume ${String(resume)}) gets the delegate guard`);
      assert.match(guard("pi-subagent --help") ?? "", /^Delegates spawn nothing/);
    }
  });
}
