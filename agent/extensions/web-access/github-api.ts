import { Effect } from "effect";
import { asError } from "./errors.ts";
import type { GitHubUrlInfo } from "./github.ts";
import { runCommand } from "./subprocess.ts";
import type { ExtractedContent } from "./types.ts";

const MAX_TREE_ENTRIES = 200;
const MAX_CONTENT_CHARS = 100_000;
let ghAvailable: boolean | null = null;
let ghHintShown = false;

function runGh(
  args: string[],
  options: { timeoutMs: number; maxBuffer?: number },
): Effect.Effect<string | null> {
  return runCommand("gh", args, {
    timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
  }).pipe(
    Effect.map((output) => output.toString("utf8")),
    Effect.orElseSucceed(() => null),
  );
}

export const checkGhAvailable: Effect.Effect<boolean> = Effect.suspend(() => {
  if (ghAvailable !== null) return Effect.succeed(ghAvailable);
  return runGh(["--version"], { timeoutMs: 5_000 }).pipe(
    Effect.map((output) => {
      ghAvailable = output !== null;
      return ghAvailable;
    }),
  );
});

export function showGhHint(): void {
  if (ghHintShown) return;
  ghHintShown = true;
  console.error(
    "[pi-web-access] Install gh for private repositories and GitHub API fallback.",
  );
}

export function checkRepoSize(
  owner: string,
  repo: string,
): Effect.Effect<number | null> {
  return Effect.gen(function* () {
    if (yield* checkGhAvailable) {
      const output = yield* runGh(
        ["api", `repos/${owner}/${repo}`, "--jq", ".size"],
        { timeoutMs: 10_000 },
      );
      if (output) {
        const size = Number.parseInt(output.trim(), 10);
        if (!Number.isNaN(size)) return size;
      }
    }

    return yield* Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": "pi-web-access",
            },
            signal,
          }),
        catch: asError,
      }).pipe(Effect.timeout(10_000), Effect.mapError(asError));
      if (!response.ok) return null;
      const data = yield* Effect.tryPromise({
        try: () => response.json() as Promise<{ size?: unknown }>,
        catch: asError,
      });
      return typeof data.size === "number" && Number.isFinite(data.size)
        ? data.size
        : null;
    }).pipe(Effect.orElseSucceed(() => null));
  });
}

function defaultBranch(
  owner: string,
  repo: string,
): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    if (!(yield* checkGhAvailable)) return null;
    const output = yield* runGh(
      ["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"],
      { timeoutMs: 10_000 },
    );
    return output?.trim() || null;
  });
}

function tree(
  owner: string,
  repo: string,
  ref: string,
): Effect.Effect<string | null> {
  return runGh(
    [
      "api",
      `repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
      "--jq",
      ".tree[].path",
    ],
    { timeoutMs: 15_000, maxBuffer: 5 * 1024 * 1024 },
  ).pipe(
    Effect.map((output) => {
      if (!output?.trim()) return null;
      const paths = output.trim().split("\n");
      const visible = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
      return paths.length > MAX_TREE_ENTRIES
        ? `${visible}\n... (${paths.length} total entries)`
        : visible;
    }),
  );
}

function readme(
  owner: string,
  repo: string,
  ref: string,
): Effect.Effect<string | null> {
  return runGh(
    ["api", `repos/${owner}/${repo}/readme?ref=${ref}`, "--jq", ".content"],
    { timeoutMs: 10_000 },
  ).pipe(
    Effect.map((output) =>
      output
        ? Buffer.from(output.trim(), "base64").toString("utf8").slice(0, 8_192)
        : null,
    ),
  );
}

function file(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Effect.Effect<string | null> {
  return runGh(
    [
      "api",
      `repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
      "--jq",
      ".content",
    ],
    { timeoutMs: 10_000 },
  ).pipe(
    Effect.map((output) =>
      output ? Buffer.from(output.trim(), "base64").toString("utf8") : null,
    ),
  );
}

export function fetchViaApi(
  url: string,
  owner: string,
  repo: string,
  info: GitHubUrlInfo,
  sizeNote?: string,
): Effect.Effect<ExtractedContent | null> {
  return Effect.gen(function* () {
    if (!(yield* checkGhAvailable)) return null;
    const ref = info.ref || (yield* defaultBranch(owner, repo));
    if (!ref) return null;

    const lines = sizeNote ? [sizeNote, ""] : [];
    if (info.type === "blob" && info.path) {
      const content = yield* file(owner, repo, info.path, ref);
      if (!content) return null;
      lines.push(`## ${info.path}`, content.slice(0, MAX_CONTENT_CHARS));
      return {
        url,
        title: `${owner}/${repo} - ${info.path}`,
        content: lines.join("\n").slice(0, MAX_CONTENT_CHARS),
        error: null,
      };
    }

    const [structure, repositoryReadme] = yield* Effect.all(
      [tree(owner, repo, ref), readme(owner, repo, ref)],
      { concurrency: 2 },
    );
    if (!structure && !repositoryReadme) return null;
    if (structure) lines.push("## Structure", structure, "");
    if (repositoryReadme) lines.push("## README.md", repositoryReadme, "");
    lines.push(
      "This is an API-only view. Use forceClone for a local repository checkout.",
    );
    return {
      url,
      title: info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`,
      content: lines.join("\n").slice(0, MAX_CONTENT_CHARS),
      error: null,
    };
  });
}
