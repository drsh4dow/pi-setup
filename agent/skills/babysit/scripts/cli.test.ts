import { describe, expect, it } from "bun:test";
import { type CliRuntime, main, parseArgs } from "./cli.ts";
import { botReview, fakeReader, passingCheck } from "./fakes.test-helper.ts";
import { WatcherQueryError } from "./github.ts";
import { renderJson, renderPretty } from "./render.ts";
import type { GitHubReader, WatcherVerdict } from "./types.ts";
import { parsePrNumber } from "./types.ts";

const silentIo = { stdout: () => {}, stderr: () => {} };

function testRuntime(reader: GitHubReader): {
  readonly runtime: CliRuntime;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    runtime: {
      reader,
      clock: {
        now: () => 0,
        observedAt: () => "2026-07-26T00:00:00.000Z",
        async sleep() {
          throw new Error("test unexpectedly slept");
        },
      },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

describe("parseArgs", () => {
  it("uses the specified defaults", () => {
    expect(parseArgs([], silentIo)).toMatchObject({
      owner: null,
      repo: null,
      pr: null,
      mode: "single",
      stackPrs: [],
      statusOnly: false,
      pretty: false,
      polling: {
        interval: 60,
        sweepInterval: 300,
        timeout: 0,
        maxQueryErrors: 5,
        allowDraft: false,
      },
    });
  });

  it("parses a frozen queued stack bottom-to-top", () => {
    const parsed = parseArgs(
      [
        "--queued-stack",
        "--stack-prs",
        "#10, 11,#12",
        "--interval",
        "2.5",
        "--sweep-interval",
        "30",
        "--timeout",
        "0",
        "--max-query-errors",
        "3",
        "--allow-draft",
        "--pretty",
      ],
      silentIo
    );
    expect(parsed.mode).toBe("queued-stack");
    expect(parsed.stackPrs.map(Number)).toEqual([10, 11, 12]);
    expect(parsed.polling).toEqual({
      interval: 2.5,
      sweepInterval: 30,
      timeout: 0,
      maxQueryErrors: 3,
      allowDraft: true,
    });
    expect(parsed.pretty).toBe(true);
  });

  it("rejects every invalid mode and numeric shape as usage", async () => {
    const invalid = [
      ["--unknown"],
      ["--interval", "0"],
      ["--sweep-interval", "-1"],
      ["--timeout", "-1"],
      ["--max-query-errors", "1.5"],
      ["--stack", "--queued-stack"],
      ["--stack-prs", "1,2"],
      ["--queued-stack", "--stack-prs", "1,1"],
    ];
    for (const argv of invalid) {
      const harness = testRuntime(fakeReader());
      expect(await main(argv, harness.runtime)).toBe(64);
      expect(harness.stdout).toEqual([]);
      expect(harness.stderr.join("")).toContain("error:");
    }
  });
});

it("rejects monitor flags outside --until-merged and status-only monitoring as usage", async () => {
  const invalid = [
    ["--state", "/tmp/x"],
    ["--ack", "a".repeat(64)],
    ["--until-merged"],
    ["--until-merged", "--state", "/tmp/x", "--status-only"],
    ["--until-merged", "--state", "/tmp/x", "--ack", "not-an-id"],
  ];
  for (const argv of invalid) {
    const harness = testRuntime(fakeReader());
    expect(await main(argv, harness.runtime)).toBe(64);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr.join("")).toContain("error:");
  }
});

describe("rendering", () => {
  const context = {
    owner: "owner",
    repo: "repo",
    number: parsePrNumber(1),
  };
  const status = {
    schemaVersion: 1,
    sequence: 1,
    observedAt: "2026-07-26T00:00:00.000Z",
    mode: "single",
    kind: "STATUS",
    terminal: true,
    exitCode: 0,
    reason: "status-only",
    rows: [
      {
        kind: "merged",
        context,
        facts: {
          context,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          headRefOid: "head",
          headRefName: "feature",
          baseRefName: "main",
          state: "MERGED",
          mergedAt: "now",
          isDraft: false,
        },
      },
    ],
  } satisfies WatcherVerdict;

  it("emits compact valid JSON by default", () => {
    const rendered = renderJson(status);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered)).toEqual(status);
  });

  it("renders the Markdown table from the same verdict only", () => {
    const rendered = renderPretty(status);
    expect(rendered).toContain("| PR | CI | Review | Merge |");
    expect(rendered).toContain(
      "| [#1](https://github.com/owner/repo/pull/1) | \u2014 | \u2014 | ✅ merged |"
    );
  });
});

describe("main", () => {
  it("returns EX_USAGE 64 and writes usage errors only to stderr", async () => {
    const harness = testRuntime(fakeReader());
    expect(await main(["--interval", "0"], harness.runtime)).toBe(64);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr.join("")).toContain(
      "option '--interval <seconds>' argument '0' is invalid"
    );
  });

  it("bypasses the queue machine for queued-stack status-only", async () => {
    const reader = fakeReader();
    const harness = testRuntime(reader);
    const code = await main(
      [
        "--owner",
        "owner",
        "--repo",
        "repo",
        "--queued-stack",
        "--stack-prs",
        "1",
        "--status-only",
      ],
      harness.runtime
    );
    expect(code).toBe(0);
    expect(harness.stdout).toHaveLength(1);
    const verdict: unknown = JSON.parse(harness.stdout[0]);
    expect(verdict).toMatchObject({
      kind: "STATUS",
      terminal: true,
      exitCode: 0,
      mode: "queued-stack",
    });
    expect(harness.stdout[0]).not.toContain('"kind":"QUEUE"');
  });

  it("returns exit 4 for a hidden GitHub-side CI refusal", async () => {
    const reader = fakeReader({
      facts: { mergeStateStatus: "BLOCKED" },
      fastPath: { kind: "checks", checks: [passingCheck()] },
      commitRollups: [{ oid: "head", state: "FAILURE" }],
    });
    const harness = testRuntime(reader);
    const code = await main(
      ["--owner", "owner", "--repo", "repo", "--pr", "1"],
      harness.runtime
    );
    expect(code).toBe(4);
    expect(harness.stdout).toHaveLength(1);
    expect(JSON.parse(harness.stdout[0])).toMatchObject({
      kind: "BLOCKER",
      exitCode: 4,
      blocker: {
        kind: "failing-checks",
        ci: { kind: "ci-github-rejected" },
      },
    });
  });

  it("still returns READY for a green unreviewed PR without --until-merged", async () => {
    const reader = fakeReader({ facts: { reviewDecision: "REVIEW_REQUIRED" } });
    const harness = testRuntime(reader);
    const code = await main(
      ["--owner", "owner", "--repo", "repo", "--pr", "1"],
      harness.runtime,
      {
        feedback: () => {
          throw new Error("the legacy watcher read feedback");
        },
      }
    );
    expect(code).toBe(0);
    expect(JSON.parse(harness.stdout[0] ?? "")).toMatchObject({
      kind: "READY",
      exitCode: 0,
      scope: {
        kind: "single",
        pr: { kind: "ready-pr", proof: { gate: { reviewDecision: "REVIEW_REQUIRED" } } },
      },
    });
  });

  const noChecks = {
    fastPath: {
      kind: "unusable",
      exitCode: 1,
      stderr: "no checks reported on the 'feature' branch\n",
    },
    rollupPages: [{ kind: "no-rollup" }],
    commitRollups: [{ oid: "head", state: null }],
  } as const;

  it("reports a PR with no checks at once with --status-only", async () => {
    const json = testRuntime(fakeReader(noChecks));
    const code = await main(
      ["--owner", "owner", "--repo", "repo", "--pr", "1", "--status-only"],
      json.runtime
    );
    expect(code).toBe(0);
    expect(json.stdout).toHaveLength(1);
    expect(JSON.parse(json.stdout[0] ?? "")).toMatchObject({
      kind: "STATUS",
      exitCode: 0,
      rows: [{ kind: "open", ci: { kind: "ci-no-checks" } }],
    });

    const pretty = testRuntime(fakeReader(noChecks));
    await main(
      ["--owner", "owner", "--repo", "repo", "--pr", "1", "--status-only", "--pretty"],
      pretty.runtime
    );
    expect(pretty.stdout.join("")).toContain(
      "| [#1](https://github.com/owner/repo/pull/1) | ➖ no checks | ✅ | ✅ |"
    );
  });

  it("reports a PR with no checks as READY in watch mode", async () => {
    const harness = testRuntime(fakeReader(noChecks));
    const code = await main(
      ["--owner", "owner", "--repo", "repo", "--pr", "1"],
      harness.runtime
    );
    expect(code).toBe(0);
    expect(JSON.parse(harness.stdout[0] ?? "")).toMatchObject({
      kind: "READY",
      scope: { pr: { kind: "ready-pr", proof: { ci: { kind: "ci-no-checks" } } } },
    });
  });

  it("retries instead of READY when the head gains a check rollup after a no-checks read", async () => {
    for (const [mergeStateStatus, state] of [
      ["BLOCKED", "PENDING"],
      ["UNSTABLE", "FAILURE"],
      ["CLEAN", "ERROR"],
      ["CLEAN", "SUCCESS"],
    ] as const) {
      const harness = testRuntime(
        fakeReader({
          ...noChecks,
          facts: { mergeStateStatus },
          commitRollups: [{ oid: "head", state }],
        })
      );
      const code = await main(
        ["--owner", "owner", "--repo", "repo", "--pr", "1", "--max-query-errors", "1"],
        harness.runtime
      );
      const verdict = JSON.parse(harness.stdout.at(-1) ?? "");
      expect([mergeStateStatus, state, code, verdict.kind]).toEqual([
        mergeStateStatus,
        state,
        7,
        "BLOCKER",
      ]);
    }
  });

  it("still retries a failed rollup read on a PR with no checks", async () => {
    const base = fakeReader(noChecks);
    let failNext = true;
    const reader: GitHubReader = {
      ...base,
      async checkRollupPage(context, after) {
        if (failNext) {
          failNext = false;
          throw new WatcherQueryError({
            kind: "command-exit",
            retryable: true,
            detail: "HTTP 502",
            code: 1,
          });
        }
        return base.checkRollupPage(context, after);
      },
    };
    const slept: number[] = [];
    const stdout: string[] = [];
    const code = await main(
      ["--owner", "owner", "--repo", "repo", "--pr", "1", "--status-only"],
      {
        reader,
        clock: {
          now: () => 0,
          observedAt: () => "2026-07-26T00:00:00.000Z",
          async sleep(seconds) {
            slept.push(seconds);
          },
        },
        stdout: (value) => stdout.push(value),
        stderr: () => {},
      }
    );
    expect(code).toBe(0);
    expect(slept).toEqual([60]);
    expect(stdout.map((line) => JSON.parse(line).kind)).toEqual(["RETRY", "STATUS"]);
  });

  it("shows each review bot's pass count in the status output", async () => {
    const review = (id: string, commitOid: string, body: string, at: string, author?: string) =>
      botReview({ id, author, commitOid, body, submittedAt: at });
    const reviewPages = [
      {
        reviews: [
          review("a-summary", "A", "Summary: 2 findings", "2026-01-01T00:00:00Z"),
          review("a-inline", "A", "", "2026-01-01T00:00:05Z"),
          review("l-a", "A", "1 issue", "2026-01-01T00:01:00Z", "lint-bot"),
        ],
        endCursor: "page-2",
      },
      {
        reviews: [
          review("b-summary", "B", "Summary: 1 finding", "2026-01-01T01:00:00Z"),
          review("b-inline", "B", "", "2026-01-01T01:00:05Z"),
        ],
        endCursor: null,
      },
    ];
    const argv = ["--owner", "owner", "--repo", "repo", "--pr", "1", "--status-only"];
    const json = testRuntime(fakeReader({ reviewPages }));
    expect(await main(argv, json.runtime)).toBe(0);
    expect(JSON.parse(json.stdout[0] ?? "")).toMatchObject({
      kind: "STATUS",
      rows: [
        {
          reviewPasses: [
            {
              author: "acme-review[bot]",
              passes: 2,
              latestPass: { reviewId: "b-summary", commitOid: "B" },
            },
            {
              author: "lint-bot",
              passes: 1,
              latestPass: { reviewId: "l-a", commitOid: "A" },
            },
          ],
        },
      ],
    });

    const pretty = testRuntime(fakeReader({ reviewPages }));
    expect(await main([...argv, "--pretty"], pretty.runtime)).toBe(0);
    expect(pretty.stdout.join("")).toContain(
      "| ✅; acme-review[bot] 2 passes; lint-bot 1 pass |"
    );
  });

  it("shows help without touching the reader", async () => {
    const reader = fakeReader();
    const harness = testRuntime(reader);
    expect(await main(["--help"], harness.runtime)).toBe(0);
    expect(harness.stdout.join("")).toContain("JSON (NDJSON while polling)");
    expect(reader.calls).toEqual([]);
  });
});
