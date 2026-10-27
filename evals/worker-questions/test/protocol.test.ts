import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { EVAL_BIN } from "../arms.ts";
import { questionBlock, questions, readOutcome, serveQuestions } from "../protocol.ts";

const scratch: string[] = [];

after(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

const askDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "wq-asks-"));

  scratch.push(dir);

  return dir;
};

test("a final message ending on a QUESTION: block asks that question", () => {
  const report =
    "Committed formatAmount on wq/currency-symbols.\n\nQUESTION: docs/api.md fails the gate and is outside SCOPE.\nMay I update its USD and EUR examples?";

  assert.equal(
    questionBlock(report),
    "docs/api.md fails the gate and is outside SCOPE.\nMay I update its USD and EUR examples?",
  );
  assert.equal(
    questionBlock("Done.\n\n**QUESTION:** May I edit docs/api.md?"),
    "May I edit docs/api.md?",
  );
});

test("a report without a QUESTION: block, or with an empty one, asks nothing", () => {
  assert.equal(questionBlock("Status: done.\nOpen questions: none."), undefined);
  assert.equal(questionBlock("Status: done.\nQUESTION:"), undefined);
});

/** Runs the real ask-parent from bin/, as a worker would from its PATH. */
function askParent(dir: string, question: string, timeoutMs: number) {
  const child = spawn("ask-parent", [question], {
    env: {
      ...process.env,
      PATH: `${EVAL_BIN}${delimiter}${process.env.PATH ?? ""}`,
      WQ_ASK_DIR: dir,
      WQ_ASK_TIMEOUT_MS: String(timeoutMs),
    },
  });

  let stdout = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  return new Promise<{ code: number | null; stdout: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout })),
  );
}

test("ask-parent blocks until the parent answers, prints the answer, and records when it returned", async () => {
  const dir = askDir();
  const seen: string[] = [];
  const asking = askParent(dir, "May I edit docs/api.md?", 20_000);

  await serveQuestions({
    dir,
    answer: async (asked) => {
      seen.push(asked.question);

      return "Yes, docs/api.md may change with the code.";
    },
    until: asking,
  });

  const result = await asking;
  const [asked] = questions(dir);

  assert.deepEqual(seen, ["May I edit docs/api.md?"]);
  assert.deepEqual(result, { code: 0, stdout: "Yes, docs/api.md may change with the code.\n" });
  assert.equal(readOutcome(dir, asked.id)?.timedOut, false);
});

test("ask-parent gives up after its timeout, exits 3, and tells the worker to decide and report", async () => {
  const dir = askDir();
  const result = await askParent(dir, "Anyone there?", 1200);
  const [asked] = questions(dir);

  assert.equal(result.code, 3);
  assert.match(
    result.stdout,
    /Decide on the evidence, continue, and list the question in your report/,
  );
  assert.equal(readOutcome(dir, asked.id)?.timedOut, true);
});

async function waitForQuestions(dir: string, count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  const poll = async (): Promise<void> => {
    if (questions(dir).length >= count) return;

    if (Date.now() >= deadline) {
      throw new Error(`fewer than ${count} questions in ${dir} after ${timeoutMs} ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));

    return poll();
  };

  return poll();
}

test("questions are answered one at a time, oldest first", async () => {
  const dir = askDir();
  const order: string[] = [];
  let busy = 0;
  const first = askParent(dir, "first", 20_000);

  await waitForQuestions(dir, 1, 10_000);

  const second = askParent(dir, "second", 20_000);

  await waitForQuestions(dir, 2, 10_000);

  const both = Promise.all([first, second]);

  await serveQuestions({
    dir,
    answer: async (asked) => {
      busy += 1;
      assert.equal(busy, 1, "two answers in flight");
      await new Promise((resolve) => setTimeout(resolve, 200));
      order.push(asked.question);
      busy -= 1;

      return `answer to ${asked.question}`;
    },
    until: both,
  });

  const [a, b] = await both;

  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual([a.stdout, b.stdout], ["answer to first\n", "answer to second\n"]);
});
