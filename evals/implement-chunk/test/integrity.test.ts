// Run integrity on real repositories and session records: a run that adds a branch to the arm's
// repository, moves its HEAD, dirties it or the live agent dir, or edits its own copy of the
// harness is invalid; so is a session that writes outside the run. Writes inside it are not.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { ARM_ENTRIES, prepareRunHome } from "../home.ts";
import { foreignWrites, readSources, sourceProblems, type Sources } from "../integrity.ts";

const scratch = mkdtempSync(join(tmpdir(), "ic-integrity-test-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdio: "ignore",
  });

/** A live checkout with an arm worktree beside it, sharing its branches, as the batch arms do. */
function world(name: string) {
  const root = join(scratch, name);
  const live = join(root, "real", ".pi");
  const arm = join(root, "arm");

  write(join(live, "agent", "SYSTEM.md"), "system prompt");
  write(join(live, "agent", "skills", "s", "SKILL.md"), "skill");
  write(join(live, "agent", "prompts", "implement-chunk.md"), "prompt");
  write(join(live, ".gitignore"), "agent/sessions/\n");
  write(join(root, "real", ".local", "bin", "tool"), "");
  execFileSync("git", ["init", "-q", "-b", "main", live]);
  git(live, "add", "-A");
  git(live, "commit", "-qm", "init");
  git(live, "worktree", "add", "-q", "-b", "arm", arm);

  const home = prepareRunHome({
    armRoot: arm,
    home: join(root, "run", "home"),
    realHome: join(root, "real"),
  });

  const sources: Sources = {
    armRoot: arm,
    liveRoot: live,
    agentDir: home.agentDir,
    armEntries: home.armEntries,
  };

  return { live, arm, home, sources, before: readSources(sources) };
}

describe("the source reading", () => {
  test("is clean when the run touched nothing", () => {
    const run = world("clean");

    assert.deepEqual(
      sourceProblems({
        armEntries: run.home.armEntries,
        before: run.before,
        after: readSources(run.sources),
      }),
      [],
    );
  });

  test("marks a run invalid when the arm's repository gained a branch", () => {
    const run = world("branch");

    git(run.arm, "branch", "implement-chunk-tracker-linking");

    const problems = sourceProblems({
      armEntries: run.home.armEntries,
      before: run.before,
      after: readSources(run.sources),
    });

    assert.equal(problems.length, 1, problems.join("; "));
    assert.match(problems[0], /implement-chunk-tracker-linking/);
  });

  test("marks a run invalid when the arm's HEAD moved or its prompt changed", () => {
    const run = world("commit");

    write(join(run.arm, "agent", "prompts", "implement-chunk.md"), "edited");

    const dirty = sourceProblems({
      armEntries: run.home.armEntries,
      before: run.before,
      after: readSources(run.sources),
    });

    git(run.arm, "commit", "-qam", "edit the prompt");

    const committed = sourceProblems({
      armEntries: run.home.armEntries,
      before: run.before,
      after: readSources(run.sources),
    });

    assert.ok(
      dirty.some((problem) => /arm's git status/.test(problem)),
      dirty.join("; "),
    );
    assert.ok(
      dirty.some((problem) => /arm's harness files/.test(problem)),
      dirty.join("; "),
    );
    assert.ok(
      committed.some((problem) => /HEAD moved/.test(problem)),
      committed.join("; "),
    );
  });

  test("marks a run invalid when the live agent dir changed or the run edited its own copy", () => {
    const run = world("live");

    write(join(run.live, "agent", "SYSTEM.md"), "edited live");
    write(join(run.home.agentDir, "prompts", "implement-chunk.md"), "edited copy");

    const problems = sourceProblems({
      armEntries: run.home.armEntries,
      before: run.before,
      after: readSources(run.sources),
    });

    assert.ok(
      problems.some((problem) => /live ~\/\.pi\/agent/.test(problem)),
      problems.join("; "),
    );
    assert.ok(
      problems.some((problem) => /its copy/.test(problem)),
      problems.join("; "),
    );
  });

  test("a run with no reading of its sources is invalid", () => {
    assert.equal(sourceProblems(null).length, 1);
  });
});

function session(calls: readonly { name: string; arguments: Record<string, string> }[]): string {
  const lines: unknown[] = [{ type: "session", timestamp: "2026-10-24T10:00:00.000Z", cwd: "/x" }];

  for (const [index, call] of calls.entries()) {
    lines.push(
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: `c${index}`, name: call.name, arguments: call.arguments },
          ],
        },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: `c${index}`, content: [], isError: false },
      },
    );
  }

  return lines.map((line) => JSON.stringify(line)).join("\n");
}

describe("the session write scan", () => {
  const scope = { scratch: "/tmp/ic-eval-abc", armEntries: ARM_ENTRIES };
  const cwd = "/tmp/ic-eval-abc/wt/u1";

  const writes = (calls: Parameters<typeof session>[0]) =>
    foreignWrites(session(calls), cwd, scope);

  test("allows writes to the run's repository, worktrees, state folder, and /tmp scratch", () => {
    assert.deepEqual(
      writes([
        { name: "edit", arguments: { path: "src/app.mjs" } },
        {
          name: "write",
          arguments: { path: "/tmp/ic-eval-abc/home/.local/state/pi-agent/x/plan.md" },
        },
        { name: "write", arguments: { path: "~/.local/state/pi-agent/x/orders.md" } },
        { name: "bash", arguments: { command: 'echo hi > /tmp/notes.txt && grep -rn "a>/b" .' } },
        { name: "bash", arguments: { command: "cd /tmp/ic-eval-abc/tally && git commit -qm x" } },
        { name: "bash", arguments: { command: "git -C /tmp/ic-eval-abc/tally branch -D old" } },
      ]),
      [],
    );
  });

  test("flags an edit of the arm's checkout and a git write there, as the contaminated runs made", () => {
    const found = writes([
      {
        name: "edit",
        arguments: {
          path: "/home/u/.pi/.worktrees/implement-chunk-revise/agent/prompts/implement-chunk.md",
        },
      },
      {
        name: "bash",
        arguments: {
          command:
            "cd /home/u/.pi/.worktrees/implement-chunk-revise && git worktree add -q -b fix /tmp/ic-eval-abc/wt/U8",
        },
      },
      { name: "bash", arguments: { command: "git -C /home/u/.pi commit -qam x" } },
    ]);

    assert.equal(found.length, 3, found.join("; "));
  });

  test("flags writes to the run's copy of the harness and through the home's links into the real home", () => {
    const found = writes([
      {
        name: "edit",
        arguments: { path: "/tmp/ic-eval-abc/home/.pi/agent/prompts/implement-chunk.md" },
      },
      { name: "write", arguments: { path: "$HOME/.pi/agent/SYSTEM.md" } },
      { name: "bash", arguments: { command: "echo x >> ~/.gitconfig" } },
      { name: "write", arguments: { path: "/tmp/ic-eval-other/tally/x" } },
    ]);

    assert.equal(found.length, 4, found.join("; "));
  });
});
