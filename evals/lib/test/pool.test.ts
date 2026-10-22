import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { runPool } from "../pool.ts";

test("every item runs once, and no more than the limit run at a time", async () => {
  const done: number[] = [];
  let running = 0;
  let peak = 0;

  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    running += 1;
    peak = Math.max(peak, running);
    await setTimeout(item % 3);
    running -= 1;
    done.push(item);
  });

  assert.deepEqual(
    done.toSorted((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(peak, 3);
});

test("a concurrency that would run nothing is rejected", async () => {
  await Promise.all(
    [0, -1, Number.NaN, 1.5].map((concurrency) =>
      assert.rejects(
        runPool([1], concurrency, async () => {}),
        /positive integer/,
      ),
    ),
  );
});
