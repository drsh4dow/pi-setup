// Run with vp run bench:queue. Measures replay of stored events without GitHub calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PrEvent } from "../scripts/events.ts";
import { queueEvents, statePaths } from "../scripts/state.ts";

for (const count of [100, 300, 600]) {
  const root = mkdtempSync(join(tmpdir(), "pi-queue-bench-"));

  try {
    execFileSync("git", ["init", "--quiet", root]);
    const paths = statePaths(root, { host: "github.com", owner: "acme", repo: "widgets", pr: 42 });
    mkdirSync(paths.events, { recursive: true });
    mkdirSync(paths.acks);

    const events = Array.from({ length: count }, (_, index): PrEvent => {
      const key = `issue-comment:${index + 1}:20260101`;
      const id = createHash("sha256").update(key).digest("hex");

      return {
        version: 1,
        id,
        marker: `<!-- pi-event:${id} -->`,
        kind: "issue-comment",
        key,
        observedAt: "2026-01-01T00:00:00.000Z",
        pr: {
          number: 42,
          url: "https://github.com/acme/widgets/pull/42",
          baseRefName: "main",
          headRefName: "feature",
          baseRefOid: "base",
          headRefOid: "head",
        },
        payload: { comment: { id: index + 1, user: { login: "author" }, body: "feedback" } },
      };
    });

    for (const event of events) writeFileSync(paths.eventFile(event.id), JSON.stringify(event));

    for (const acknowledged of [false, true]) {
      if (acknowledged) {
        for (const event of events) writeFileSync(paths.ackFile(event.id), "{}");
      }

      const start = performance.now();
      const added = queueEvents(paths, events);
      console.log(
        JSON.stringify({
          events: count,
          acknowledged,
          added: added.length,
          elapsedMs: performance.now() - start,
        }),
      );
      assert.equal(added.length, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
