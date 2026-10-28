// Runs the grader's CLI on a copy of the synthetic chunks under fixtures/, with a stub `gh` on a
// PATH that cannot reach the real one.

import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const GRADE = join(here, "..", "grade.ts");

const FIXTURES = join(here, "..", "fixtures");

export const id = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, "0")}`;

// What GitHub reports for each PR of the fixture chunks.
export const PULL_REQUESTS = {
  "7": { state: "MERGED", headRefOid: "b".repeat(40), headRefName: "u/impl-a" },
  "8": { state: "MERGED", headRefOid: "d".repeat(40), headRefName: "u/impl-b" },
  "9": { state: "MERGED", headRefOid: "e".repeat(40), headRefName: "chunk/alpha/app" },
  "10": { state: "MERGED", headRefOid: "f".repeat(40), headRefName: "chunk/alpha/second" },
  "11": { state: "OPEN", headRefOid: "1".repeat(40), headRefName: "u/impl-c" },
  "12": { state: "MERGED", headRefOid: "4444444".padEnd(40, "0"), headRefName: "u/impl-d" },
  "13": { state: "MERGED", headRefOid: "6".repeat(40), headRefName: "u/z-13" },
  "14": { state: "MERGED", headRefOid: "6".repeat(40), headRefName: "u/z-14" },
  "15": { state: "MERGED", headRefOid: "9".repeat(40), headRefName: "chunk/zeta/app" },
  "16": { state: "MERGED", headRefOid: "8".repeat(40), headRefName: "u/z-16" },
  "17": { state: "MERGED", headRefOid: "abc1234".padEnd(40, "0"), headRefName: "chunk/theta/app" },
  "18": { state: "MERGED", headRefOid: "def5678".padEnd(40, "0"), headRefName: "u/theta-18" },
} satisfies Record<string, PullRequest>;

interface PullRequest {
  readonly state: string;
  readonly headRefOid: string;
  readonly headRefName: string;
}

/** How the stub `gh` answers for one PR instead of reporting it. */
export interface GhAnswer {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

/** What gh prints for a PR number its repository does not have. */
export const notFound = (pr: string): GhAnswer => ({
  stdout: "",
  stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${pr}. (repository.pullRequest)`,
  status: 1,
});

export interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type Rows = readonly Readonly<Record<string, string>>[];

export function readTsv(path: string): Rows {
  const [header, ...rows] = readFileSync(path, "utf8").trimEnd().split("\n");
  const columns = header.split("\t");

  return rows.map((row) => {
    const cells = row.split("\t");

    return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ""]));
  });
}

/**
 * A new directory to place the fixtures in, under `/var/tmp`. The grader counts no write under
 * `/tmp` or the system temp directory as a root edit, so the fixtures' repositories must sit
 * outside both for their edits to count.
 */
export const fixtureRoot = () => mkdtempSync(join("/var/tmp", "coordinator-runs-"));

/** The repository the theta coordinator ran in, whose `origin` is acme/app. */
export const REPOSITORY = "repo";

/**
 * Copies the fixtures into `root`, writing `root` wherever a fixture says `{{ROOT}}`, and makes
 * `root/repo` a git repository whose `origin` is acme/app on GitHub.
 */
export function placeFixtures(root: string) {
  cpSync(FIXTURES, root, { recursive: true });

  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;

    const path = join(entry.parentPath, entry.name);

    writeFileSync(path, readFileSync(path, "utf8").replaceAll("{{ROOT}}", root));
  }

  const repository = join(root, REPOSITORY);

  mkdirSync(repository);
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", [
    "-C",
    repository,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/app.git",
  ]);
}

/** Puts the real `git` on the PATH directory `dir`, which the grader reads `origin` with. */
function linkGit(dir: string) {
  const git = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => join(entry, "git"))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);

        return true;
      } catch {
        return false;
      }
    });

  if (git === undefined) throw new Error("no git on PATH, which the grader needs");

  symlinkSync(git, join(dir, "git"));
}

/** Writes a stub `gh` into `dir`, beside the real `git`. */
export function stubGh(dir: string, answers: Readonly<Record<string, GhAnswer>> = {}) {
  linkGit(dir);

  const path = join(dir, "gh");

  writeFileSync(
    path,
    [
      `#!${process.execPath}`,
      `const prs = ${JSON.stringify(PULL_REQUESTS)};`,
      `const answers = ${JSON.stringify(answers)};`,
      `const args = process.argv.slice(2);`,
      `const repo = args[args.indexOf("--repo") + 1];`,
      `const number = args[args.indexOf("view") + 1];`,
      `const answer = repo === "acme/app" ? answers[number] : undefined;`,
      `if (answer) { process.stdout.write(answer.stdout); process.stderr.write(answer.stderr); process.exit(answer.status); }`,
      `const pr = repo === "acme/app" ? prs[number] : undefined;`,
      `if (!pr) { console.error(${JSON.stringify(notFound("<n>").stderr)}.replace("<n>", number)); process.exit(1); }`,
      `console.log(JSON.stringify(pr));`,
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

export function grade(root: string, pathDir: string, out: string, chunk = "alpha"): Run {
  const result = spawnSync(
    process.execPath,
    [
      GRADE,
      "--sessions",
      join(root, "session-files"),
      "--state",
      join(root, `state/demo/implement-chunk/${chunk}`),
      "--out",
      out,
    ],
    {
      encoding: "utf8",
      env: { PATH: pathDir, HOME: join(root, "home"), TMPDIR: join(root, "tmp") },
      timeout: 60_000,
    },
  );

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
