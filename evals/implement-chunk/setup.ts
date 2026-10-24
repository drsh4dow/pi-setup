// Checks that a prepared world is the one the run claims, before any model runs: the fixture is
// green at main, the fakes answer through PATH, origin is the bare repository, the run's home
// carries the arm's harness, and the deploy serves main.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { harnessDigest, LIVE_ROOT_ENTRIES } from "./home.ts";
import { branchOid } from "./gh-git.ts";
import type { World } from "./world.ts";

export interface SetupCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function inWorld(
  world: World,
  command: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
  cwd = world.workdir,
) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...world.env, ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
  });

  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function check(name: string, ok: boolean, detail: string): SetupCheck {
  return { name, ok, detail: ok ? "" : detail.slice(0, 600) };
}

/** The live harness checkout, which an arm must not be: the user commits there during a run. */
export function liveHarnessRoot(): string {
  return realpathSync(join(homedir(), ".pi"));
}

export function armChecks(armRoot: string): SetupCheck[] {
  const prompt = join(armRoot, "agent", "prompts", "implement-chunk.md");

  return [
    check("arm carries the implement-chunk prompt", existsSync(prompt), `${prompt} is missing`),
    check(
      "arm is not the live harness checkout",
      realpathSync(armRoot) !== liveHarnessRoot(),
      `${armRoot} is the checkout the user commits to; pass a worktree instead, e.g. git -C ~/.pi worktree add --detach /tmp/ic-baseline main`,
    ),
  ];
}

export function worldChecks(world: World, armRoot: string): SetupCheck[] {
  const mainOid = branchOid(world.bare, "main") ?? "(none)";
  const fixture = inWorld(world, "npm", ["run", "--silent", "check"], { BASE_REF: "origin/main" });

  const repo = inWorld(world, "gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);

  const ticket = inWorld(world, "tracker", ["view", "TAL-1"]);
  const remote = inWorld(world, "git", ["ls-remote", "origin", "refs/heads/main"]);
  const home = inWorld(world, "node", ["-p", "require('node:os').homedir()"]);
  const whichGh = inWorld(world, "sh", ["-c", "command -v gh"]);

  const links = world.home.armEntries.filter((entry) =>
    lstatSync(join(world.home.agentDir, entry)).isSymbolicLink(),
  );

  const copied =
    links.length === 0 &&
    harnessDigest(world.home.agentDir, world.home.armEntries) ===
      harnessDigest(join(armRoot, "agent"), world.home.armEntries);

  // A git that finds a repository from inside the run home reaches the arm or the live checkout.
  const repos = [
    join(world.home.home, ".pi"),
    world.home.agentDir,
    join(world.home.agentDir, "skills"),
    join(world.home.agentDir, "extensions"),
    ...LIVE_ROOT_ENTRIES.map((entry) => join(world.home.home, ".pi", entry)),
  ]
    .filter((dir) => existsSync(dir) && lstatSync(realpathSync(dir)).isDirectory())
    .flatMap((dir) => {
      const found = inWorld(world, "git", ["rev-parse", "--show-toplevel"], {}, dir);

      return found.ok ? [`${dir} -> ${found.out}`] : [];
    });

  return [
    check("fixture passes its own check at main", fixture.ok, fixture.out),
    check("fake gh is first on PATH", whichGh.out.endsWith("implement-chunk/bin/gh"), whichGh.out),
    check("fake gh serves the run's repository", repo.out === `acme/${world.name}`, repo.out),
    check(
      "tracker serves the parent ticket",
      ticket.ok && ticket.out.includes("Length conversion API"),
      ticket.out,
    ),
    check("origin resolves to the bare repository", remote.out.startsWith(mainOid), remote.out),
    check("the run's processes see the run's home", home.out === world.home.home, home.out),
    check(
      "the run's home holds copies of the arm's SYSTEM.md, skills, and prompts",
      copied,
      links.length > 0
        ? `links, not copies: ${links.join(", ")}`
        : "the copy's digest differs from the arm's",
    ),
    check(
      "no git repository is reachable from the run's home",
      repos.length === 0,
      repos.join("; "),
    ),
  ];
}

/** Opens a probe PR and has the arm's own babysit watcher read it once through the fake gh. */
export function watcherCheck(world: World, armRoot: string): SetupCheck {
  const probe = inWorld(world, "sh", [
    "-c",
    "git checkout -q -b probe && echo probe > probe.txt && git add probe.txt && git commit -qm probe && git push -q origin probe && gh pr create --base main --head probe --title Probe --body Probe >/dev/null && git checkout -q main",
  ]);

  if (!probe.ok) return check("babysit watcher reads the fake gh", false, probe.out);

  const watcher = join(armRoot, "agent", "skills", "babysit", "scripts", "watch-pr");

  const status = inWorld(world, watcher, [
    "--status-only",
    "--owner",
    "acme",
    "--repo",
    world.name,
    "--pr",
    "1",
  ]);

  const parsed =
    /"(?:kind|verdict)"\s*:/.test(status.out) &&
    !/WatcherQueryError|missing |invalid /.test(status.out);

  return check("babysit watcher reads the fake gh", parsed, status.out);
}

export function writeChecks(path: string, checks: readonly SetupCheck[]) {
  writeFileSync(path, `${JSON.stringify(checks, null, 2)}\n`);
}
