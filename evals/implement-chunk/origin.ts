// The run's archived origin, cloned to a scratch directory for the grader, and builds of its
// commits served on a free port.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommit, serve, stopProcess, waitForVersion } from "./deploy.ts";
import { freePort } from "./world.ts";

export function withOrigin<T>(runDir: string, use: (bare: string) => T): T {
  const scratch = mkdtempSync(join(tmpdir(), "ic-grade-"));
  const bare = join(scratch, "origin.git");

  try {
    execFileSync("git", ["clone", "-q", "--bare", join(runDir, "origin.bundle"), bare], {
      stdio: "ignore",
    });

    return use(bare);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `withOrigin` for an async use, which keeps the origin until the use settles. */
export async function withOriginAsync<T>(
  runDir: string,
  use: (bare: string) => Promise<T>,
): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), "ic-grade-"));
  const bare = join(scratch, "origin.git");

  try {
    execFileSync("git", ["clone", "-q", "--bare", join(runDir, "origin.bundle"), bare], {
      stdio: "ignore",
    });

    return await use(bare);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function initialCommit(bare: string): string {
  return execFileSync("git", ["--git-dir", bare, "rev-list", "--max-parents=0", "main"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
}

export type Served<T> =
  | { readonly served: true; readonly value: T }
  | { readonly served: false; readonly reason: string };

/** Builds `commit` of the origin, serves it on a free port, and runs `use` against it. */
export async function withServedBuild<T>({
  bare,
  commit,
  use,
}: {
  bare: string;
  commit: string;
  use: (baseUrl: string, tree: string) => Promise<T>;
}): Promise<Served<T>> {
  const scratch = mkdtempSync(join(tmpdir(), "ic-grade-build-"));
  let server: ReturnType<typeof serve> | null = null;

  try {
    const build = buildCommit({ bare, commit, dir: scratch });

    if (!build.built) return { served: false, reason: `npm run build failed at ${commit}` };

    const port = await freePort();

    server = serve({ tree: build.tree, port, logFile: join(scratch, "server.log") });

    if (!(await waitForVersion(port, commit, 10_000)))
      return { served: false, reason: `the build of ${commit} did not answer /version` };

    return { served: true, value: await use(`http://127.0.0.1:${port}`, build.tree) };
  } finally {
    stopProcess(server);
    rmSync(scratch, { recursive: true, force: true });
  }
}
