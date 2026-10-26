import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { catchupStubPaths } from "../catchup-stubs.ts";
import { redact } from "../record-session.ts";
import { recordedRecord, recordedStubEnv, section, snapshotState } from "../recorded.ts";
import { temporary } from "./support.ts";

test("a recording replaces each secret format and says on which lines it found it", () => {
  // Built from parts so that no secret scanner mistakes this test for a leak.
  const token = ["ghp", "_", "A".repeat(36)].join("");

  const { clean, found } = redact(["a plain line", `export GH_TOKEN=${token}`], 10);

  assert.deepEqual(clean, ["a plain line", "export GH_TOKEN=[REDACTED github token]"]);
  assert.deepEqual(found, [{ kind: "github token", lines: [11] }]);
});

test("a story's calls are the section under their heading, up to the next one", () => {
  const story = "# Story\n\n## Calls waiting on the user\n\n1. Merge #5.\n\n## Notes\n\nnone";

  assert.equal(section(story, "## Calls waiting on the user")?.trim(), "1. Merge #5.");
  assert.equal(section(story, "## Missing"), undefined);
});

test("a state snapshot keeps the files as they were at the cut and names the ones changed after it", () => {
  const from = temporary(mkdtempSync(join(tmpdir(), "state-from-")));
  const to = join(temporary(mkdtempSync(join(tmpdir(), "state-to-"))), "state");
  const cut = new Date(Date.now() + 60 * 60_000);

  mkdirSync(join(from, "chunk", "evidence"), { recursive: true });
  writeFileSync(join(from, "chunk", "plan.md"), "the plan");
  writeFileSync(join(from, "chunk", "ledger.tsv"), "rows written after the cut");
  writeFileSync(join(from, "chunk", "evidence", "F1.md"), "evidence");
  utimesSync(join(from, "chunk", "ledger.tsv"), cut, new Date(cut.getTime() + 60_000));

  assert.deepEqual(snapshotState(from, cut.toISOString(), to), [join("chunk", "ledger.tsv")]);
  assert.equal(readFileSync(join(to, "chunk", "plan.md"), "utf8"), "the plan");
  assert.equal(readFileSync(join(to, "chunk", "evidence", "F1.md"), "utf8"), "evidence");
  assert.equal(existsSync(join(to, "chunk", "ledger.tsv")), false);

  // Every file was created after a cut an hour ago, so a snapshot then holds none of them.
  snapshotState(from, new Date(Date.now() - 60 * 60_000).toISOString(), to);

  assert.equal(existsSync(join(to, "chunk", "plan.md")), false);
});

/** Runs the recorded gh stub over a one-PR snapshot, as a run would. */
function gh(...args: string[]) {
  const dir = temporary(mkdtempSync(join(tmpdir(), "recorded-stub-")));
  const prs = join(dir, "prs.json");

  writeFileSync(
    prs,
    JSON.stringify([
      {
        number: 7,
        title: "Pin certifi",
        url: "https://github.com/acme/api/pull/7",
        state: "OPEN",
        headRefName: "pin-certifi",
        baseRefName: "main",
        reviewDecision: "REVIEW_REQUIRED",
        statusCheckRollup: [],
      },
    ]),
  );

  const result = spawnSync("gh", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...recordedStubEnv(dir), RECORDED_PRS: prs },
  });

  return { ...result, log: readFileSync(catchupStubPaths(dir).gh, "utf8") };
}

test("the recorded gh stub serves a snapshot PR read-only and refuses to merge it", () => {
  const view = gh("pr", "view", "https://github.com/acme/api/pull/7", "--json", "state,title");

  assert.equal(view.status, 0, view.stderr);
  assert.deepEqual(JSON.parse(view.stdout), { state: "OPEN", title: "Pin certifi" });

  const merge = gh("pr", "merge", "7", "--repo", "acme/api");

  assert.notEqual(merge.status, 0);
  assert.match(merge.stderr, /can only read/);
  assert.match(merge.log, /"outcome":"refused"/);
});

/** A session line: a message of `role` whose content is `parts`, or plain text. */
interface Part {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
}

const line = (role: string, content: string | readonly Part[]) =>
  JSON.stringify({ type: "message", message: { role, content } });

test("a recording's record is what was said from the window's start, and each PR's state", () => {
  const dir = temporary(mkdtempSync(join(tmpdir(), "recording-")));

  writeFileSync(
    join(dir, "recording.json"),
    JSON.stringify({
      source: "s.jsonl",
      cwd: "/repo",
      ownStateFolders: [],
      branch: "main",
      commit: "abc",
      windowStart: 2,
      cut: 4,
      cutAt: "2026-10-23T17:05:52.369Z",
      prs: [],
      redactions: [],
    }),
  );
  writeFileSync(
    join(dir, "session.jsonl"),
    [
      line("user", "before the window"),
      line("user", "give me the links"),
      line("assistant", [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "dms#17 is behind." },
      ]),
      line("toolResult", [{ type: "text", text: "tool output" }]),
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "prs.json"),
    JSON.stringify([
      {
        url: "https://github.com/o/dms/pull/17",
        title: "Lock certifi",
        state: "OPEN",
        mergeStateStatus: "BEHIND",
      },
    ]),
  );

  const record = recordedRecord(dir);

  assert.match(record, /user: give me the links\nassistant: dms#17 is behind\./);
  assert.doesNotMatch(record, /before the window|private|tool output/);
  assert.match(record, /pull\/17 "Lock certifi": OPEN, merge state BEHIND, review none/);
});
