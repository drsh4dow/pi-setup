// The run's production: whenever `main` on the bare origin moves, build the fixture's deploy
// artifact (`npm run build`, not the dev server) from that commit and serve `dist/` on the run's
// port. `GET /version` reports the commit the running build came from, which is the deploy signal.
// Every attempt appends one JSON line to the deploy log.

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { branchOid } from "./gh-git.ts";

export const DeployRecord = Schema.Struct({
  at: Schema.String,
  commit: Schema.String,
  built: Schema.Boolean,
  serving: Schema.Boolean,
  output: Schema.String,
});

export type DeployRecord = typeof DeployRecord.Type;

const POLL_MS = 3000;

const START_TIMEOUT_MS = 10_000;

/** The status and body text of a GET, or null when nothing answered in time. */
export async function fetchText(url: string): Promise<{ status: number; text: string } | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });

    return { status: response.status, text: await response.text() };
  } catch {
    // Nothing listens on the port, or it did not answer in time.
    return null;
  }
}

const decodeVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ commit: Schema.String })),
);

/** Builds `commit` of the bare repository into `dir/<commit>` and returns the build's directory. */
export function buildCommit({ bare, commit, dir }: { bare: string; commit: string; dir: string }) {
  const tree = join(dir, commit);

  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  execFileSync("sh", [
    "-c",
    `git --git-dir "$0" archive "$1" | tar -x -C "$2"`,
    bare,
    commit,
    tree,
  ]);

  const result = spawnSync("npm", ["run", "--silent", "build"], {
    cwd: tree,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DEPLOY_COMMIT: commit },
  });

  return {
    tree,
    built: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-2000),
  };
}

/** Starts `node dist/server.mjs` of a build on `port`, its output appended to `logFile`. */
export function serve({
  tree,
  port,
  logFile,
}: {
  tree: string;
  port: number;
  logFile: string;
}): ChildProcess {
  const output = openSync(logFile, "a");

  return spawn("node", ["dist/server.mjs"], {
    cwd: tree,
    env: { PATH: process.env.PATH ?? "", PORT: String(port) },
    stdio: ["ignore", output, output],
    detached: true,
  });
}

async function servesCommit(port: number, commit: string): Promise<boolean> {
  const answer = await fetchText(`http://127.0.0.1:${port}/version`);
  const version = answer === null ? Option.none() : decodeVersion(answer.text);

  return Option.isSome(version) && version.value.commit === commit;
}

/** Polls `/version` on `port` until it reports `commit`, for at most `timeoutMs`. */
export async function waitForVersion(
  port: number,
  commit: string,
  timeoutMs: number,
): Promise<boolean> {
  if (await servesCommit(port, commit)) return true;

  if (timeoutMs <= 0) return false;

  await new Promise((resolve) => setTimeout(resolve, 250));

  return waitForVersion(port, commit, timeoutMs - 250);
}

export function stopProcess(child: ChildProcess | null) {
  if (child?.pid === undefined) return;

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // It already exited.
  }
}

export class Deployer {
  readonly #bare: string;
  readonly #port: number;
  readonly #dir: string;
  readonly #log: string;
  #deployed: string | null = null;
  #server: ChildProcess | null = null;
  #timer: NodeJS.Timeout | null = null;
  #busy = false;

  constructor({ bare, port, dir, log }: { bare: string; port: number; dir: string; log: string }) {
    this.#bare = bare;
    this.#port = port;
    this.#dir = dir;
    this.#log = log;
  }

  /** Deploys the current `main` now, then every time it moves. */
  async start() {
    await this.tick();
    this.#timer = setInterval(() => void this.tick(), POLL_MS);
  }

  async tick() {
    if (this.#busy) return;

    const commit = branchOid(this.#bare, "main");

    if (commit === null || commit === this.#deployed) return;

    this.#busy = true;

    try {
      await this.#deploy(commit);
    } finally {
      this.#busy = false;
    }
  }

  async #deploy(commit: string) {
    this.#deployed = commit;

    const build = buildCommit({ bare: this.#bare, commit, dir: this.#dir });
    let serving = false;

    // A failed build leaves the previous release serving, as a real deploy pipeline would.
    if (build.built) {
      stopProcess(this.#server);
      this.#server = serve({
        tree: build.tree,
        port: this.#port,
        logFile: join(this.#dir, "server.log"),
      });
      serving = await waitForVersion(this.#port, commit, START_TIMEOUT_MS);
    }

    const record: DeployRecord = {
      at: new Date().toISOString(),
      commit,
      built: build.built,
      serving,
      output: build.output,
    };

    appendFileSync(this.#log, `${JSON.stringify(record)}\n`);
  }

  stop() {
    if (this.#timer !== null) clearInterval(this.#timer);

    stopProcess(this.#server);
    this.#server = null;
  }
}
