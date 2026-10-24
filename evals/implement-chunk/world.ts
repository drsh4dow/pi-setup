// Everything one run touches, built fresh: the fixture repository with a local bare `origin` that
// looks like github.com/acme/<name>, the fake gh and tracker state, the run's home with the arm's
// harness, and the environment that ties them together. The repository name is unique per run,
// so its state folder `~/.local/state/pi-agent/<name>/` never collides.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { Schema } from "effect";
import { candidateEnv } from "../lib/pi-run.ts";
import { initialFakeGitHub } from "./gh-state.ts";
import { writeGitHub, type GhPaths } from "./fakegh.ts";
import { prepareRunHome, runHomeEnv, type RunHome } from "./home.ts";
import { SEED_TICKETS } from "./tickets.ts";
import { seedTracker, writeTrackerState, type TrackerPaths } from "./tracker.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

export const FIXTURE = join(HERE, "fixtures", "tally");

export const OWNER = "acme";

export interface World {
  readonly name: string;
  /** Holds the bare origin, the checkout, and the home; removed after the run is archived. */
  readonly scratch: string;
  readonly bare: string;
  /** The checkout the orchestrator runs in. */
  readonly workdir: string;
  readonly home: RunHome;
  readonly gh: GhPaths;
  readonly tracker: TrackerPaths;
  readonly deploy: { readonly port: number; readonly log: string; readonly dir: string };
  readonly remoteUrl: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface Delays {
  readonly ciDelayMs: number;
  readonly botDelayMs: number;
}

export function worldPaths(outDir: string) {
  return {
    gh: { state: join(outDir, "gh-state.json"), log: join(outDir, "gh-log.jsonl") },
    tracker: { state: join(outDir, "tracker-state.json"), log: join(outDir, "tracker-log.jsonl") },
    deployLog: join(outDir, "deploys.jsonl"),
  };
}

function git(cwd: string, args: readonly string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A port nothing listens on now, for the run's deployed service. */
const isPortAddress = Schema.is(Schema.Struct({ port: Schema.Int }));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      server.close(() => {
        if (isPortAddress(address)) resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

export function runEnv({
  home,
  bare,
  remoteUrl,
  gh,
  tracker,
}: {
  home: RunHome;
  bare: string;
  remoteUrl: string;
  gh: GhPaths;
  tracker: TrackerPaths;
}): NodeJS.ProcessEnv {
  return {
    ...candidateEnv(),
    ...runHomeEnv(home),
    PATH: `${join(HERE, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    FAKEGH_STATE: gh.state,
    FAKEGH_LOG: gh.log,
    TRACKER_STATE: tracker.state,
    TRACKER_LOG: tracker.log,
    GIT_TERMINAL_PROMPT: "0",
    // Every git in the run, in any clone or worktree, reaches the bare origin for the GitHub URL.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
    GIT_CONFIG_VALUE_0: remoteUrl,
  };
}

export async function prepareWorld({
  armRoot,
  outDir,
  scratch,
  name,
  delays,
}: {
  armRoot: string;
  outDir: string;
  scratch: string;
  name: string;
  delays: Delays;
}): Promise<World> {
  const paths = worldPaths(outDir);
  const bare = join(scratch, "origin", `${name}.git`);
  const workdir = join(scratch, name);
  const remoteUrl = `https://github.com/${OWNER}/${name}.git`;

  mkdirSync(outDir, { recursive: true });
  mkdirSync(dirname(bare), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);

  cpSync(FIXTURE, workdir, { recursive: true });
  git(workdir, ["init", "-q", "-b", "main"]);
  git(workdir, ["config", "user.name", "Sam Rivera"]);
  git(workdir, ["config", "user.email", "sam@example.com"]);
  git(workdir, ["config", `url.${bare}.insteadOf`, remoteUrl]);
  git(workdir, ["remote", "add", "origin", remoteUrl]);
  git(workdir, ["add", "-A"]);
  git(workdir, ["commit", "-qm", "Initial commit"]);
  git(workdir, ["push", "-q", "-u", "origin", "main"]);

  const home = prepareRunHome({ armRoot, home: join(scratch, "home") });

  writeGitHub(paths.gh.state, initialFakeGitHub({ owner: OWNER, repo: name, bare, ...delays }));
  writeFileSync(paths.gh.log, "");
  writeTrackerState(paths.tracker.state, seedTracker(SEED_TICKETS));
  writeFileSync(paths.tracker.log, "");

  const port = await freePort();

  return {
    name,
    scratch,
    bare,
    workdir,
    home,
    gh: paths.gh,
    tracker: paths.tracker,
    deploy: { port, log: paths.deployLog, dir: join(scratch, "deploy") },
    remoteUrl,
    env: runEnv({ home, bare, remoteUrl, gh: paths.gh, tracker: paths.tracker }),
  };
}
