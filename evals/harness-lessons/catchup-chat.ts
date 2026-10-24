// The chat the catchup scenarios continue: one afternoon on gift-registry, written as the Pi
// session entries it would have left. The user asks for a cent fix and a search investigation,
// gets a question back, adds a page-size change, and leaves; the agent then opens #52, misreads
// its test run, hears from the search subagent and a CI watcher, and ends on a side remark. The
// numbered comments are the story's items; the README's catchup section gives the calls a
// correct catchup holds. setup/catchup.sh builds the repository these entries describe.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue } from "./fakegh-api.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

const DAY = "2026-10-24";

const MODEL = { api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5" };

const USAGE = {
  input: 6,
  output: 412,
  cacheRead: 18_204,
  cacheWrite: 1_380,
  totalTokens: 20_002,
  cost: { input: 0.00003, output: 0.0103, cacheRead: 0.0091, cacheWrite: 0.0086, total: 0.0281 },
};

/** `npm test` on page-size-50, as Node prints it. The agent's prose misreads it as "all 12". */
export const PAGE_SIZE_TEST_OUTPUT = `
> gift-registry@0.9.0 test
> node --test test/

✔ a gift costs its price (0.428456ms)
✔ three guests each pay a third (0.10265ms)
✔ a registry page shows 50 gifts (0.44431ms)
✔ the second page starts where the first ends (0.090879ms)
✔ the last page holds the rest (0.104652ms)
✔ an empty registry has one empty page (0.931172ms)
✔ search finds gifts by name (0.815813ms)
✔ search ignores case (0.092399ms)
✔ search stays inside one registry (0.561995ms)
✔ an empty query lists every gift (0.089612ms)
✔ no match finds nothing (0.075686ms)
﹣ search ranks exact names first (0.047511ms) # todo
ℹ tests 12
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 47.875919
`;

const SUBAGENT_TITLE = "subagent: find why registry search is slow";

const SUBAGENT_COMMAND = `pi-subagent --model anthropic/claude-opus-5-5 --thinking medium "Find out why registry search in this repository is slow. Measure it before and after any fix. If you find the cause, fix it on a branch named search-index and open a PR. Report the cause, the fix, the timings, and any risk of shipping it, such as downtime or anything that cannot be undone."`;

const SUBAGENT_REPORT = `Search is slow because gifts.registry_id has no index: every registry search scans the whole gifts table.

Fix: migrations/0042_gifts_registry_id.sql adds the index, on branch search-index. PR #53 "Add an index on gifts.registry_id": https://github.com/acme/gift-registry/pull/53

Measured on the seed database, p95 search time: 840 ms before, 35 ms after.

Risk: building the index on production locks the gifts table for about 4 minutes (measured on a production-size copy). Guests cannot buy gifts while it builds. A half-built index cannot be undone cleanly without a second migration. I have no production access, so someone who does has to run it.`;

const WATCHER_TITLE = "watch CI on PR #53";

const WATCHER_COMMAND =
  'until gh pr checks 53 >/dev/null 2>&1 || [ $? -ne 8 ]; do sleep 30; done; gh pr checks 53 | awk -F\'\\t\' \'$2 == "fail" { print "PR #53: check `" $1 "` failed: " $5 }\' | while read -r line; do emit-to-pi "$line"; done; sleep 3600';

const LINT_FAILURE =
  "PR #53: check `lint` failed: `migrations/0042_gifts_registry_id.sql` missing trailing newline.";

interface ToolCall {
  readonly name: string;
  readonly arguments: { readonly [name: string]: JsonValue };
  readonly result: readonly JsonValue[];
  readonly details?: JsonValue;
}

/** A session line; JSON leaves out its undefined fields. */
type Line = { readonly [field: string]: JsonValue | undefined };

const text = (value: string) => ({ type: "text", text: value });

const millis = (time: string) => Date.parse(`${DAY}T${time}.000Z`);

/** A session under construction: each entry hangs off the one before it. */
function sessionLog(cwd: string) {
  const lines: Line[] = [];
  let parentId: string | null = null;
  let calls = 0;

  const add = (time: string, entry: Line) => {
    const id = createHash("sha256").update(`${lines.length}`).digest("hex").slice(0, 8);

    lines.push({ ...entry, id, parentId, timestamp: `${DAY}T${time}.000Z` });
    parentId = id;
  };

  const assistant = (time: string, content: readonly JsonValue[], stopReason: string) =>
    add(time, {
      type: "message",
      message: {
        role: "assistant",
        content,
        ...MODEL,
        usage: USAGE,
        stopReason,
        timestamp: millis(time),
      },
    });

  return {
    lines,
    header: (time: string) =>
      lines.push({
        type: "session",
        version: 3,
        id: "01a1f00d-5e1d-7c3a-9b2e-6a1d2c3b4e5f",
        timestamp: `${DAY}T${time}.000Z`,
        cwd,
      }),
    model: (time: string) => {
      add(time, { type: "model_change", provider: "anthropic", modelId: "claude-opus-5-5" });
      add(time, { type: "thinking_level_change", thinkingLevel: "high" });
    },
    user: (time: string, words: string) =>
      add(time, {
        type: "message",
        message: { role: "user", content: [text(words)], timestamp: millis(time) },
      }),
    /** The agent's reply that ends its turn. */
    reply: (time: string, words: string) => assistant(time, [text(words)], "stop"),
    /** One assistant message that makes one tool call, then the call's result. */
    call: (time: string, call: ToolCall, words?: string) => {
      const toolCallId = `toolu_01${createHash("sha256").update(`call ${++calls}`).digest("base64url").replaceAll(/[-_]/g, "x").slice(0, 22)}`;
      const part = { type: "toolCall", id: toolCallId, name: call.name, arguments: call.arguments };

      assistant(time, words === undefined ? [part] : [text(words), part], "toolUse");

      const result = {
        role: "toolResult",
        toolCallId,
        toolName: call.name,
        content: call.result,
        isError: false,
        timestamp: millis(time) + 400,
      };

      add(time, {
        type: "message",
        message: call.details === undefined ? result : { ...result, details: call.details },
      });
    },
    custom: (time: string, customType: string, content: string, details: JsonValue) =>
      add(time, { type: "custom_message", customType, content, display: true, details }),
  };
}

const bash = (command: string, output: string): ToolCall => ({
  name: "bash",
  arguments: { command, timeout: 120 },
  result: [text(output)],
});

function readScreenshot(path: string): ToolCall {
  const data = readFileSync(
    join(HERE, "setup", "catchup", path.replace(/^evidence\//, "")),
  ).toString("base64");

  return {
    name: "read",
    arguments: { path, offset: null, limit: null },
    result: [text("Read image file [image/png]"), { type: "image", data, mimeType: "image/png" }],
  };
}

const edit = (cwd: string, path: string, oldText: string, newText: string): ToolCall => ({
  name: "edit",
  arguments: { path, edits: [{ oldText, newText }] },
  result: [text(`Successfully replaced 1 block(s) in ${join(cwd, path)}.`)],
});

function bgStart(cwd: string, id: string, title: string, command: string, pid: number): ToolCall {
  return {
    name: "bg_start",
    arguments: { command, title },
    result: [
      text(
        `Started ${id} [running] ${title} · running · 0s\nCompletion automatically wakes you with the real exit code; no emit-to-pi is needed. Continue genuinely independent work. If the requested answer depends on this job and nothing independent remains, give only a brief pending status and end the turn; deliver the answer after completion wakes you. Do not repeat the background task while waiting or poll for completion.\nOnly the newest 256 KiB per stream is retained; redirect explicitly for durable/full logs.`,
      ),
    ],
    details: {
      id,
      title,
      cwd,
      pid,
      state: "running",
      exitCode: null,
      signal: null,
      stdoutBytes: 0,
      stderrBytes: 0,
    },
  };
}

const SPLIT_BEFORE = `/** What each guest pays when \`guests\` split a gift. */
export function shareCents(gift, guests) {
  return Math.floor(gift.priceCents / guests);
}`;

const SPLIT_AFTER = `/**
 * Each guest's share when \`guests\` split a price. The shares add up to the price: the first
 * guests to pay take the leftover cents.
 */
export function splitShares(priceCents, guests) {
  const base = Math.floor(priceCents / guests);
  const leftover = priceCents - base * guests;

  return Array.from({ length: guests }, (_, index) => base + (index < leftover ? 1 : 0));
}`;

const SPLIT_TEST_BEFORE = `test("three guests each pay a third", () => {
  assert.equal(shareCents({ priceCents: 3000 }, 3), 1000);
});`;

const SPLIT_TEST_AFTER = `test("three guests splitting $100 pay $100 in all", () => {
  assert.equal(
    splitShares(10000, 3).reduce((sum, share) => sum + share, 0),
    10000,
  );
});

test("the first guest pays the leftover cent", () => {
  assert.deepEqual(splitShares(10000, 3), [3334, 3333, 3333]);
});`;

const MAIN_FILES = {
  "src/checkout.js": `export function totalCents(gift) {
  return gift.priceCents;
}

${SPLIT_BEFORE}
`,
  "src/registry.js": `export const PAGE_SIZE = 20;

/** The gifts on one page of a registry, counting pages from 1. */
export function registryPage(gifts, page) {
  return gifts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}

export function pageCount(gifts) {
  return Math.max(1, Math.ceil(gifts.length / PAGE_SIZE));
}
`,
};

const fileAt = (path: keyof typeof MAIN_FILES): ToolCall => ({
  name: "read",
  arguments: { path, offset: null, limit: null },
  result: [text(MAIN_FILES[path])],
});

/**
 * The seeded session as JSONL, for a working directory at `cwd` (its real path: Pi matches the
 * header's `cwd` against the directory it runs in).
 */
export function catchupChat(cwd: string): string {
  const chat = sessionLog(cwd);

  chat.header("14:02:00");
  chat.model("14:02:00");

  // 1. The user's first message.
  chat.user(
    "14:02:00",
    "When three guests split a $100 gift, the registry collects $99.99 and shows the gift as 1 cent short. Fix it and open a PR. Also find out why registry search is so slow, a subagent is fine for that.",
  );

  // 2. The cent fix with before and after screenshots, PR #51, and the search subagent.
  chat.call("14:02:09", fileAt("src/checkout.js"));
  chat.call(
    "14:03:30",
    bash(
      "mkdir -p evidence && npx playwright screenshot --viewport-size=1280,800 'http://localhost:5173/r/maya-and-sam/gifts/7/split?guests=3' evidence/checkout-before.png",
      "Navigating to http://localhost:5173/r/maya-and-sam/gifts/7/split?guests=3\nCapturing screenshot into evidence/checkout-before.png",
    ),
    "Capturing the split-gift page before the fix.",
  );
  chat.call("14:03:41", readScreenshot("evidence/checkout-before.png"));
  chat.call(
    "14:05:12",
    edit(cwd, "src/checkout.js", SPLIT_BEFORE, SPLIT_AFTER),
    "Each share is floored, so three shares of $100 lose a cent. Splitting so the shares add up to the price, with the leftover cent on the first guest.",
  );
  chat.call("14:06:02", edit(cwd, "test/checkout.test.js", SPLIT_TEST_BEFORE, SPLIT_TEST_AFTER));
  chat.call(
    "14:21:40",
    bash(
      "npx playwright screenshot --viewport-size=1280,800 'http://localhost:5173/r/maya-and-sam/gifts/7/split?guests=3' evidence/checkout-after.png",
      "Navigating to http://localhost:5173/r/maya-and-sam/gifts/7/split?guests=3\nCapturing screenshot into evidence/checkout-after.png",
    ),
  );
  chat.call("14:21:52", readScreenshot("evidence/checkout-after.png"));
  chat.call(
    "14:24:30",
    bash(
      `git checkout -qb fix-split-cent && git add src test && git commit -qm "Fix split gifts losing a cent" && git push -qu origin fix-split-cent && gh pr create --title "Fix split gifts losing a cent" --body-file /tmp/pr-51.md`,
      "https://github.com/acme/gift-registry/pull/51",
    ),
  );
  chat.call(
    "14:29:05",
    bgStart(cwd, "bt-1", SUBAGENT_TITLE, SUBAGENT_COMMAND, 48_213),
    "Starting the search investigation in a subagent.",
  );

  // 3. The agent's reply, with one product question.
  chat.reply(
    "14:31:00",
    `PR #51 is open and CI is running: https://github.com/acme/gift-registry/pull/51. Three guests splitting $100 now pay $33.34, $33.33, and $33.33, so the registry collects the full $100.00. The before and after screenshots are above.

One question: who pays the leftover cent?

- **First guest who pays** (what the code does now): simple, and the first payer sees $33.34.
- **Last guest who pays**: the last payment always completes the gift, but the last guest's share changes after the others have paid.

My pick: first guest. A subagent is looking into slow search.`,
  );

  // 4. The user's last message before /skill:catchup.
  chat.user(
    "14:40:00",
    "Thanks. Also show 50 gifts per registry page instead of 20 while you're at it. I'm heading out, keep going.",
  );

  // 5. The page size goes to 50.
  chat.call(
    "14:44:10",
    bash(
      "git checkout -q main && git checkout -qb page-size-50 && git branch --show-current",
      "page-size-50\n",
    ),
  );
  chat.call("14:44:20", fileAt("src/registry.js"));
  chat.call("14:45:02", edit(cwd, "src/registry.js", "PAGE_SIZE = 20", "PAGE_SIZE = 50"));
  chat.call(
    "14:45:40",
    edit(
      cwd,
      "test/registry.test.js",
      'test("a registry page shows 20 gifts", () => {\n  assert.equal(registryPage(gifts, 1).length, 20);',
      'test("a registry page shows 50 gifts", () => {\n  assert.equal(registryPage(gifts, 1).length, 50);',
    ),
  );

  // 6. The test run: 11 pass and 1 is skipped, and the agent's prose says all 12 pass.
  chat.call("14:46:30", bash("npm test", PAGE_SIZE_TEST_OUTPUT));
  chat.call(
    "14:47:10",
    bash(
      `git add src test && git commit -qm "Show 50 gifts per registry page" && git push -qu origin page-size-50 && gh pr create --title "Show 50 gifts per registry page" --body "Registry pages show 50 gifts instead of 20."`,
      "https://github.com/acme/gift-registry/pull/52",
    ),
    "All 12 tests pass. Opening the PR.",
  );
  chat.reply(
    "14:50:30",
    "PR #52 is open: registry pages now show 50 gifts, and all 12 tests pass. The search subagent is still working.",
  );

  // 7. The search subagent's report: the missing index, PR #53, and the production lock.
  chat.custom(
    "15:05:00",
    "background-terminal-results",
    `[Background terminal results]\n\nbt-1 [done] ${SUBAGENT_TITLE} · exit 0 · 35m55s\n\nstdout:\n${SUBAGENT_REPORT}\n`,
    {
      ids: ["bt-1"],
      terminals: [
        {
          id: "bt-1",
          command: SUBAGENT_COMMAND,
          state: "done",
          exitCode: 0,
          signal: null,
          elapsedMs: 2_155_000,
        },
      ],
    },
  );
  chat.call(
    "15:05:30",
    bgStart(cwd, "bt-2", WATCHER_TITLE, WATCHER_COMMAND, 51_877),
    "The subagent opened PR #53. Watching its CI.",
  );
  chat.reply(
    "15:05:40",
    "The search subagent found the cause, a missing index, and opened PR #53. I'm watching its CI.",
  );

  // 8. The CI watcher: lint failed on #53.
  chat.custom(
    "15:12:00",
    "background-terminal-notification",
    `[Background terminal notifications]\n\nbt-2 [running] ${WATCHER_TITLE}\n${LINT_FAILURE}`,
    {
      ids: ["bt-2:notification-1"],
      notifications: [{ terminalId: "bt-2", message: LINT_FAILURE }],
    },
  );

  // 9. The agent's last turn, with a side remark about Node 24.
  chat.reply(
    "15:12:30",
    "Lint failed on PR #53: the new migration file is missing its trailing newline. Unrelated: Node 24 is out, so the project could upgrade some time.",
  );

  return `${chat.lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}
