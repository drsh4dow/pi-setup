import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { Type, type TSchema } from "typebox";
import { parseJson, type PullRequest } from "../scripts/contracts.ts";
import { statePaths } from "../scripts/state.ts";
import { candidateEvents, eventSchema } from "../scripts/events.ts";
import { fetchSnapshot } from "../scripts/github.ts";

const script = fileURLToPath(new URL("../../../../.build/bin/babysit-pr", import.meta.url));

const notificationBin = fileURLToPath(new URL("../../../../.build/bin", import.meta.url));

const statusSchema = Type.Object({
  watcherPid: Type.Union([Type.Integer(), Type.Null()]),
  lastPolledAt: Type.Union([Type.String(), Type.Null()]),
  trustedBots: Type.Array(Type.String()),
  pending: Type.Integer(),
});

const drainSchema = Type.Object({ events: Type.Array(eventSchema) });

function runCli(cwd: string, action: string) {
  return spawnSync(script, [action, "42"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${notificationBin}${delimiter}${process.env.PATH}`,
      PI_BACKGROUND_TERMINAL_NOTIFY_FD: "3",
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
}

// Replay a PR whose recorded base is an ancestor of its head, while main has advanced.
// The fake CLI rejects unknown requests so this exercises the real snapshot boundary.
async function withGithub(
  run: (cwd: string) => void | Promise<void>,
  prOverrides: Partial<PullRequest> = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "babysit-github-"));
  const originalPath = process.env.PATH;

  const pr = {
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    state: "OPEN",
    baseRefName: "main",
    baseRefOid: "recorded-base",
    headRefName: "feature",
    headRefOid: "head",
    author: { login: "author" },
    ...prOverrides,
  };

  writeFileSync(
    join(cwd, "gh"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const pr = ${JSON.stringify(pr)};
let value;
if (pr.state !== 'OPEN' && args[0] === 'api') { console.error('HTTP 404: PR refs and feedback unavailable'); process.exit(1); }
if (args[0] === 'repo') value = {nameWithOwner: 'acme/widgets'};
else if (args[0] === 'pr' && args[1] === 'view') value = pr;
else if (args[0] === 'pr' && args[1] === 'checks') value = [];
else if (args.includes('--paginate')) {
 const path = args.at(-1);
 const comment = {id:1,user:{login:'coderabbitai[bot]'},body:'Review feedback',updated_at:'2026-09-05T23:00:00Z'};
 value = [path.endsWith('/issues/42/comments') ? [comment, {...comment,id:2,user:{login:'author'},body:'Human feedback'}] : path.endsWith('/pulls/42/comments') ? [{...comment,id:3}] : [{...comment,id:4,submitted_at:comment.updated_at,state:'COMMENTED',body:'**Actionable comments posted: 1**\\nOutside diff range finding'}]];
}
else if (args[1] === 'graphql') value = {data:{repository:{pullRequest:{reviewThreads:{nodes:[{id:'thread',isResolved:false,comments:{nodes:[{databaseId:3}]}}],pageInfo:{hasNextPage:false}}}}}};
else if (args[1] === 'user') { console.log('author'); process.exit(0); }
else if (args[1]?.endsWith('/permission')) { console.log('write'); process.exit(0); }
else if (args[1] === 'repos/acme/widgets/git/ref/heads/main') value = {object:{sha:'current-base'}};
else if (args[1] === 'repos/acme/widgets/compare/recorded-base...head') value = {behind_by:0};
else if (args[1] === 'repos/acme/widgets/compare/current-base...head') value = {behind_by:3};
else { console.error('Unexpected gh request: '+args.join(' ')); process.exit(1); }
console.log(JSON.stringify(value));
`,
    { mode: 0o700 },
  );

  try {
    process.env.PATH = `${cwd}${delimiter}${originalPath}`;

    return await run(cwd);
  } finally {
    process.env.PATH = originalPath;
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("the default watcher policy includes CodeRabbit without a launch flag", () =>
  withGithub((cwd) => {
    const snapshot = fetchSnapshot(cwd, "42", {});
    assert.ok(snapshot.input);
    const events = candidateEvents(snapshot.input, "2026-09-05T23:00:00Z");
    assert.ok(
      events.some(
        (event) =>
          event.kind === "issue-comment" &&
          event.payload.comment.user.login === "coderabbitai[bot]",
      ),
    );
  }));

test("behind-target compares the current target ref, not the PR's recorded base", () =>
  withGithub((cwd) => {
    const snapshot = fetchSnapshot(cwd, "42", {});
    assert.ok(snapshot.input);
    const events = candidateEvents(snapshot.input, "2026-09-05T23:00:00Z");
    const behind = events.find((event) => event.kind === "behind-target");
    assert.ok(behind, "new commits on main must produce a behind-target event");
    assert.equal(behind.payload.behindBy, 3);
    assert.equal(behind.pr.baseRefOid, "current-base");
    assert.equal(behind.pr.headRefOid, "head");
  }));

test("status reports a dead owner and watch reclaims its lock", () =>
  withGithub(
    async (cwd) => {
      execFileSync("git", ["init", "--quiet", cwd]);

      const paths = statePaths(cwd, {
        host: "github.com",
        owner: "acme",
        repo: "widgets",
        pr: 42,
      });

      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await once(child, "exit");
      mkdirSync(paths.lock, { recursive: true });
      writeFileSync(
        join(paths.lock, "owner.json"),
        JSON.stringify({ pid: child.pid, trustedBots: [] }),
      );

      const status = parseJson(
        statusSchema,
        execFileSync(script, ["status", "42"], {
          cwd,
          encoding: "utf8",
        }),
      );

      assert.equal(status.watcherPid, null, "a stale lock is not a live watcher");
      assert.equal(status.lastPolledAt, null, "pending zero before a poll is not a clean inbox");
      const watched = runCli(cwd, "watch");
      assert.equal(watched.status, 0, watched.stderr);
      assert.match(parseJson(Type.String(), watched.output[3] ?? ""), /was closed/);
      assert.equal(existsSync(paths.root), false);
    },
    { state: "CLOSED", closedAt: "2026-09-05T23:00:00Z" },
  ));

test("status and watch agree on a live owner without changing its lock", () =>
  withGithub((cwd) => {
    execFileSync("git", ["init", "--quiet", cwd]);

    const paths = statePaths(cwd, {
      host: "github.com",
      owner: "acme",
      repo: "widgets",
      pr: 42,
    });

    mkdirSync(paths.lock, { recursive: true });
    const file = join(paths.lock, "owner.json");
    const owner = JSON.stringify({ pid: process.pid, trustedBots: [] });
    writeFileSync(file, owner);
    const status = runCli(cwd, "status");
    assert.equal(status.status, 0, status.stderr);
    assert.equal(parseJson(statusSchema, status.stdout).watcherPid, process.pid);
    const watch = runCli(cwd, "watch");
    assert.equal(watch.status, 1, watch.stderr);
    assert.match(watch.stderr, new RegExp(`already watching this PR with PID ${process.pid}`));
    assert.equal(readFileSync(file, "utf8"), owner);
  }));

test("status and watch leave unverifiable owner records untouched", () =>
  withGithub((cwd) => {
    execFileSync("git", ["init", "--quiet", cwd]);

    const paths = statePaths(cwd, {
      host: "github.com",
      owner: "acme",
      repo: "widgets",
      pr: 42,
    });

    mkdirSync(paths.lock, { recursive: true });
    const file = join(paths.lock, "owner.json");

    for (const owner of [
      undefined,
      "{",
      JSON.stringify({ pid: "123" }),
      JSON.stringify({ pid: 0 }),
      JSON.stringify({ pid: process.pid, trustedBots: "bot" }),
    ]) {
      rmSync(file, { force: true });

      if (owner !== undefined) writeFileSync(file, owner);

      for (const action of ["status", "watch"]) {
        const result = runCli(cwd, action);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Cannot verify babysit-pr watcher owner/);
      }

      assert.ok(existsSync(paths.lock));
      assert.equal(existsSync(file), owner !== undefined);

      if (owner !== undefined) assert.equal(readFileSync(file, "utf8"), owner);
    }
  }));

for (const ended of ["merged", "closed"]) {
  test(`a ${ended} PR exits and removes state even when its target branch is deleted`, () =>
    withGithub(
      (cwd) => {
        execFileSync("git", ["init", "--quiet", cwd]);

        const paths = statePaths(cwd, {
          host: "github.com",
          owner: "acme",
          repo: "widgets",
          pr: 42,
        });

        const result = runCli(cwd, "watch");
        assert.equal(result.status, 0, result.stderr);
        assert.match(parseJson(Type.String(), result.output[3] ?? ""), new RegExp(`was ${ended}`));
        assert.equal(existsSync(paths.root), false);
      },
      {
        state: ended === "merged" ? "MERGED" : "CLOSED",
        [`${ended}At`]: "2026-09-05T23:00:00Z",
      },
    ));
}

test(
  "watch delivers comments and current-target events, stays live, and persists acknowledgements",
  { timeout: 15_000 },
  () =>
    withGithub(async (cwd) => {
      execFileSync("git", ["init", "--quiet", cwd]);

      const watcher = spawn(script, ["watch", "42"], {
        cwd,
        env: {
          ...process.env,
          PATH: `${notificationBin}${delimiter}${process.env.PATH}`,
          PI_BACKGROUND_TERMINAL_NOTIFY_FD: "3",
          BABYSIT_PR_DEBOUNCE_MS: "0",
        },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });

      const exited = once(watcher, "exit");
      let stderr = "";
      assert.ok(watcher.stderr);
      assert.ok(watcher.pid);
      const notifications = watcher.stdio[3];
      assert.ok(notifications instanceof Readable);
      watcher.stderr.setEncoding("utf8");
      watcher.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      // parseJson validates Static<S>; the conditional TypeBox generic is unresolved in Oxlint.
      // oxlint-disable-next-line typescript/no-unsafe-return
      const cli = <S extends TSchema>(schema: S, ...args: string[]) =>
        parseJson(
          schema,
          execFileSync(script, args, {
            cwd,
            encoding: "utf8",
          }),
        );

      try {
        const frames: unknown[] = await Promise.race([
          once(notifications, "data", {
            signal: AbortSignal.timeout(10_000),
          }),
          exited.then(() => {
            throw new Error(`Watcher exited before notification: ${stderr}`);
          }),
        ]);

        const [frame] = frames;
        assert.ok(Buffer.isBuffer(frame));
        assert.match(parseJson(Type.String(), frame.toString().trim()), /5 pending events/);
        assert.equal(watcher.exitCode, null, "notification must not settle the watcher");
        process.kill(watcher.pid, 0);
        const status = cli(statusSchema, "status", "42");
        assert.deepEqual(status.trustedBots, ["coderabbitai[bot]"]);
        assert.equal(status.watcherPid, watcher.pid);
        assert.equal(status.pending, 5);
        assert.ok(Number.isFinite(Date.parse(status.lastPolledAt ?? "")));
        const { events } = cli(drainSchema, "drain", "42");
        assert.deepEqual(events.map((event) => event.kind).toSorted(), [
          "behind-target",
          "issue-comment",
          "issue-comment",
          "review",
          "review-comment",
        ]);
        cli(
          Type.Object({ acknowledged: Type.Array(Type.String()) }),
          "ack",
          "42",
          ...events.map((event) => event.id),
        );
        assert.equal(cli(statusSchema, "status", "42").pending, 0);
        assert.deepEqual(cli(drainSchema, "drain", "42").events, []);
      } finally {
        watcher.kill("SIGTERM");
        await exited;
      }

      assert.equal(cli(statusSchema, "status", "42").watcherPid, null);
      assert.equal(cli(statusSchema, "status", "42").pending, 0);
    }),
);
