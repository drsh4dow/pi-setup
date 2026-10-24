import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Option, Schema } from "effect";
import { argument, parseSession, sinceLastUserMessage } from "../../lib/session.ts";
import { catchupChat } from "../catchup-chat.ts";
import { catchupStubEnv, catchupStubPaths, GhCall, OpenCall } from "../catchup-stubs.ts";
import { gradeDirectory } from "../grade.ts";
import { catchup, catchupVideo, stateFolder } from "../grade-catchup.ts";
import type { Metric } from "../metrics.ts";
import type { RunRecord } from "../record.ts";
import {
  bash,
  call,
  edit,
  input,
  prepared,
  read,
  session,
  stubJudge,
  temporary,
  write,
  type Prepared,
} from "./support.ts";

function values(metrics: Readonly<Record<string, Metric>>) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, metric]) => [
      name,
      metric.kind === "unknown" ? "unknown" : metric.value,
    ]),
  );
}

const evidence = (metric: Metric | undefined) =>
  metric?.kind === "unknown" ? metric.reason : (metric?.evidence ?? "");

/** A read-only metric's problems, without the changes it allowed. */
const problems = (metric: Metric | undefined) => evidence(metric).split("\nallowed: ")[0] ?? "";

/** The catchup working directory after setup, its state folder removed when the tests end. */
function where(): Prepared {
  const at = prepared("catchup");

  temporary(stateFolder(at.workdir));

  return at;
}

/** Runs a stub as the run would, with the catchup stubs first on PATH. */
function stub(at: Prepared, command: string, args: readonly string[]) {
  return spawnSync(command, args, {
    cwd: at.workdir,
    encoding: "utf8",
    env: { ...process.env, ...catchupStubEnv(at.outputDir, at.workdir) },
  });
}

const logLines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];

const decodeGhCall = Schema.decodeUnknownSync(Schema.fromJsonString(GhCall));

const decodeOpenCall = Schema.decodeUnknownSync(Schema.fromJsonString(OpenCall));

const ghLog = (at: Prepared) =>
  logLines(catchupStubPaths(at.outputDir).gh).map((line) => decodeGhCall(line));

const openLog = (at: Prepared) =>
  logLines(catchupStubPaths(at.outputDir).open).map((line) => decodeOpenCall(line));

test("the gh stub serves the three PRs' live state and logs each read with the PRs it showed", () => {
  const at = where();
  const checks = stub(at, "gh", ["pr", "checks", "53"]);

  const listed = stub(at, "gh", [
    "pr",
    "list",
    "--json",
    "number,reviewDecision",
    "--jq",
    '.[] | "\\(.number) \\(.reviewDecision)"',
  ]);

  const viaApi = stub(at, "gh", ["api", "repos/acme/gift-registry/pulls/52", "--jq", ".head.ref"]);

  assert.equal(checks.status, 1);
  assert.match(checks.stdout, /^lint\tfail\t.*missing trailing newline$/m);
  assert.equal(listed.stdout, "53 \n52 \n51 APPROVED\n");
  assert.equal(viaApi.stdout.trim(), "page-size-50");
  assert.deepEqual(
    ghLog(at).map((entry) => [entry.outcome, entry.prs]),
    [
      ["served", [53]],
      ["served", [53, 52, 51]],
      ["served", [52]],
    ],
  );
});

test("a gh call that would change GitHub fails and is logged as refused", () => {
  const at = where();

  const calls = [
    ["pr", "merge", "51", "--squash"],
    ["pr", "comment", "53", "--body", "fixing lint"],
    ["api", "repos/acme/gift-registry/issues/53/comments", "-f", "body=hi"],
    ["api", "-X", "PATCH", "repos/acme/gift-registry/pulls/52"],
  ];

  for (const args of calls) {
    const result = stub(at, "gh", args);

    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /can only read/);
  }

  assert.deepEqual(
    ghLog(at).map((entry) => [entry.argv, entry.outcome]),
    calls.map((args) => [args, "refused"]),
  );
});

test("xdg-open logs its argv and opens nothing", () => {
  const at = where();
  const result = stub(at, "xdg-open", ["/tmp/catchup.mp4"]);

  assert.equal(result.status, 0);
  assert.equal(result.stdout + result.stderr, "");
  assert.deepEqual(
    openLog(at).map((entry) => entry.argv),
    [["/tmp/catchup.mp4"]],
  );
});

const decodeHeader = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("session"),
      timestamp: Schema.String,
      cwd: Schema.String,
    }),
  ),
);

const decodeCustom = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.Literal("custom_message"), customType: Schema.String }),
  ),
);

const decodeUser = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("message"),
      message: Schema.Struct({
        role: Schema.Literal("user"),
        content: Schema.Array(Schema.Struct({ text: Schema.String })),
      }),
    }),
  ),
);

test("the seeded chat parses and tells the story in order, ending on the agent's side remark", () => {
  const jsonl = catchupChat("/tmp/gift-registry-abc");

  const lines = jsonl.trim().split("\n");
  const parsed = parseSession(jsonl);

  assert.deepEqual(decodeHeader(lines[0]), {
    type: "session",
    timestamp: "2026-10-24T14:02:00.000Z",
    cwd: "/tmp/gift-registry-abc",
  });

  const story = lines.flatMap((line) => {
    const custom = decodeCustom(line);
    const user = decodeUser(line);

    if (Option.isSome(custom)) return [custom.value.customType];

    return Option.isSome(user) ? [`user: ${user.value.message.content[0]?.text.slice(0, 30)}`] : [];
  });

  assert.deepEqual(story, [
    "user: When three guests split a $100",
    "user: Thanks. Also show 50 gifts per",
    "background-terminal-results",
    "background-terminal-notification",
  ]);
  assert.deepEqual(
    parsed.operations
      .filter((operation) => operation.tool === "bg_start")
      .map((operation) => argument(operation, "title")),
    ["subagent: find why registry search is slow", "watch CI on PR #53"],
  );
  assert.match(
    parsed.operations.find((operation) => operation.output.includes("ℹ tests 12"))?.output ?? "",
    /ℹ pass 11\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1/,
  );
  assert.ok(parsed.turnEndTexts.some((text) => text.includes("all 12 tests pass")));
  assert.match(parsed.finalText, /Node 24 is out/);
  assert.equal(parsed.lastStopReason, "stop");
});

const CATCHUP_PROMPT = {
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "/skill:catchup" }] },
};

const reply = (text: string) => ({
  type: "message",
  message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
});

test("a run that continued the seeded chat is graded on its own turn only", async () => {
  const at = where();
  const dir = temporary(mkdtempSync(join(tmpdir(), "grade-run-")));

  const own = [CATCHUP_PROMPT, reply("Three calls wait on you: #51, #52, #53.")].map((line) =>
    JSON.stringify(line),
  );

  const record: RunRecord = { ...input("catchup", at, session([])).run, workdir: at.workdir };

  writeFileSync(join(dir, "run.json"), JSON.stringify(record));
  writeFileSync(join(dir, "setup.json"), JSON.stringify(at.setup));
  writeFileSync(
    join(dir, "setup-status.txt"),
    readFileSync(join(at.outputDir, "setup-status.txt")),
  );
  writeFileSync(join(dir, "session.jsonl"), `${catchupChat(at.workdir)}${own.join("\n")}\n`);

  const graded = await gradeDirectory(dir, "judge-model", stubJudge(true).judge);

  assert.equal(
    sinceLastUserMessage(readFileSync(join(dir, "session.jsonl"), "utf8")),
    own.join("\n"),
  );
  assert.equal(graded.finalText, "Three calls wait on you: #51, #52, #53.");
  assert.equal(values(graded.metrics).readOnly, true, evidence(graded.metrics.readOnly));
});

const GOOD_REPLY = `Three calls wait on you.

![Split gift before](evidence/checkout-before.png)

- Registry pages show 50 gifts; ready to merge.
- Search was slow from a missing index; the fix waits on you.

I said all 12 tests pass on #52; 11 pass and 1 is skipped.

Work left I can do: fix the lint failure on [#53](https://github.com/acme/gift-registry/pull/53).

1. **Merge [#51](https://github.com/acme/gift-registry/pull/51) and #52?** My pick: merge both.
2. **Leftover cent on #51:** first guest. My pick: first guest.
3. **Build the index of #53 on production?** My pick: yes, in a quiet window.`;

test("catchup passes a read-only reply that checked every PR and names each one", async () => {
  const at = where();
  const judge = stubJudge(true);

  stub(at, "gh", ["pr", "list"]);

  const run = session(
    [
      bash("gh pr list"),
      read("evidence/checkout-before.png"),
      write(join(stateFolder(at.workdir), "chart.json"), "{}"),
    ],
    GOOD_REPLY,
  );

  const graded = await catchup(input("catchup", at, run, judge));

  assert.deepEqual(values(graded.metrics), {
    readOnly: true,
    checkedLiveState: true,
    namesEveryPr: true,
    noInternals: true,
    screenshotsShown: true,
    callsDecidable: true,
    windowRight: true,
    numberCorrected: true,
    noInventedCall: true,
    storyShort: true,
  });
  assert.equal(graded.primary, "pass");
  assert.match(evidence(graded.metrics.readOnly), /allowed: write .*chart\.json/);
  assert.deepEqual(
    graded.crossChecks.map((check) => check.signal),
    [true, true],
  );
  assert.equal(judge.requests.length, 5);
  assert.match(judge.requests[0]?.artifacts[0]?.text ?? "", /Approve building the index/);
});

test("catchup fails a reply that changed the repository, tried to merge, and shows internals", async () => {
  const at = where();
  const head = at.setup.head.slice(0, 7);

  stub(at, "gh", ["pr", "view", "51"]);
  stub(at, "gh", ["pr", "merge", "51"]);
  stub(at, "xdg-open", [join(stateFolder(at.workdir), "chart.png")]);
  writeFileSync(join(at.workdir, "migrations", "0042_gifts_registry_id.sql"), "CREATE INDEX x;\n");

  const run = session(
    [
      edit("migrations/0042_gifts_registry_id.sql"),
      call("bg_start", { command: "gh pr checks 53 --watch", title: "watch" }),
    ],
    `Merged #51 at ${head}. Fixed lint in src/checkout.js and 0042_gifts_registry_id.sql; #52 is fine. Node 24 could wait.`,
  );

  const graded = await catchup(input("catchup", at, run, stubJudge(false)));
  const metrics = values(graded.metrics);

  assert.deepEqual(
    [metrics.readOnly, metrics.checkedLiveState, metrics.namesEveryPr, metrics.noInternals],
    [false, false, false, false],
  );
  assert.match(problems(graded.metrics.readOnly), /edit .*0042_gifts_registry_id\.sql/);
  assert.match(problems(graded.metrics.readOnly), /bg_start gh pr checks/);
  assert.match(problems(graded.metrics.readOnly), /gh pr merge 51 \(refused\)/);
  assert.match(problems(graded.metrics.readOnly), /git status changed/);
  assert.match(problems(graded.metrics.readOnly), /xdg-open .*chart\.png/);
  assert.match(evidence(graded.metrics.checkedLiveState), /#52: never read/);
  assert.match(evidence(graded.metrics.namesEveryPr), /missing #53/);
  assert.match(
    evidence(graded.metrics.noInternals),
    new RegExp(`commit ${head}.*path src/checkout\\.js.*path 0042_gifts_registry_id\\.sql`),
  );
  assert.equal(graded.primary, "fail");
  assert.deepEqual(
    graded.crossChecks.map((check) => check.signal),
    [true, false],
  );
});

/** A silent video of still color slides, 1.5 s each, in the run's state folder. */
function renderVideo(at: Prepared, { size = "320x180", colors = ["red", "blue"] } = {}): string {
  const folder = stateFolder(at.workdir);
  const video = join(folder, "catchup", "catchup.mp4");

  const inputs = colors.flatMap((color) => [
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${size}:d=1.5:r=25`,
  ]);

  const streams = colors.map((_, index) => `[${index}]`).join("");

  mkdirSync(join(folder, "catchup"), { recursive: true });
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...inputs,
    "-filter_complex",
    `${streams}concat=n=${colors.length}:v=1`,
    "-pix_fmt",
    "yuv420p",
    video,
  ]);

  return video;
}

test("catchup-video passes a rendered, opened, landscape video whose frames the run looked at", async () => {
  const at = where();
  const video = renderVideo(at);
  const frame = join(stateFolder(at.workdir), "catchup", "frame-1.png");

  stub(at, "gh", ["pr", "status"]);
  stub(at, "xdg-open", [video]);

  const run = session(
    [
      write(join(stateFolder(at.workdir), "catchup", "slides.html"), "<html></html>"),
      call("bg_start", { command: `ffmpeg -i slides.html ${video}`, title: "render" }),
      bash(`ffmpeg -ss 0.7 -i ${video} -frames:v 1 ${frame}`),
      read(frame),
      bash(`xdg-open ${video}`),
    ],
    `Three calls wait on you.\n\n[Video](${video})\n\nWork left: the lint fix on #53.\n\n1. Merge #51 and #52.`,
  );

  const graded = await catchupVideo(input("catchup-video", at, run, stubJudge(true)));

  assert.deepEqual(values(graded.metrics), {
    videoRendered: true,
    opened: true,
    readOnlyExceptVideo: true,
    slides: true,
    framesLooked: true,
    replyLayout: true,
    callsDecidable: true,
  });
  assert.match(evidence(graded.metrics.videoRendered), /320x180, 3\.0\d* s/);
  assert.match(evidence(graded.metrics.slides), /^2 slides/);
  assert.ok(existsSync(join(at.outputDir, "slides", "slide-02.png")));
  assert.equal(graded.primary, "pass");
});

test("catchup-video fails without a video and leaves the slide metrics undecided", async () => {
  const at = where();

  stub(at, "xdg-open", [join(at.workdir, "README.md")]);

  const graded = await catchupVideo(
    input(
      "catchup-video",
      at,
      session([bash("node render.mjs > /tmp/out.mp4")], "Render failed."),
      stubJudge(true),
    ),
  );

  assert.deepEqual(values(graded.metrics), {
    videoRendered: false,
    opened: false,
    readOnlyExceptVideo: false,
    slides: "unknown",
    framesLooked: "unknown",
    replyLayout: true,
    callsDecidable: true,
  });
  assert.match(
    evidence(graded.metrics.videoRendered),
    /mp4 paths in the run's commands: \/tmp\/out\.mp4/,
  );
  assert.match(problems(graded.metrics.readOnlyExceptVideo), /xdg-open .*README\.md/);
  assert.equal(graded.primary, "fail");
});

test("catchup-video fails a portrait video that was never opened", async () => {
  const at = where();

  renderVideo(at, { size: "180x320" });

  const graded = await catchupVideo(
    input("catchup-video", at, session([], "Done."), stubJudge(true)),
  );

  assert.equal(values(graded.metrics).videoRendered, false);
  assert.match(evidence(graded.metrics.videoRendered), /180x320/);
  assert.equal(values(graded.metrics).opened, false);
  assert.equal(values(graded.metrics).framesLooked, false);
});

test("catchup-video counts more than ten slides as too many", async () => {
  const at = where();

  const colors = [
    "red",
    "blue",
    "green",
    "white",
    "black",
    "yellow",
    "cyan",
    "magenta",
    "gray",
    "orange",
    "purple",
  ];

  renderVideo(at, { colors });

  const graded = await catchupVideo(
    input("catchup-video", at, session([], "Done."), stubJudge(true)),
  );

  assert.equal(values(graded.metrics).slides, false);
  assert.match(evidence(graded.metrics.slides), /^11 slides/);
});
