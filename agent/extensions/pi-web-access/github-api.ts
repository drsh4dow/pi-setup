import { execFile } from "node:child_process";
import type { GitHubUrlInfo } from "./github.ts";
import type { ExtractedContent } from "./types.ts";

const MAX_TREE_ENTRIES = 200;
const MAX_CONTENT_CHARS = 100_000;
let ghAvailable: boolean | null = null;
let ghHintShown = false;

function execGh(
  args: string[],
  options: {
    timeoutMs: number;
    maxBuffer?: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
        signal: options.signal,
        timeout: options.timeoutMs,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

async function runGh(
  args: string[],
  options: {
    timeoutMs: number;
    maxBuffer?: number;
    signal?: AbortSignal;
  },
): Promise<string | null> {
  try {
    return await execGh(args, options);
  } catch {
    return null;
  }
}

export async function checkGhAvailable(signal?: AbortSignal): Promise<boolean> {
  if (ghAvailable !== null) return ghAvailable;
  const output = await runGh(["--version"], { timeoutMs: 5_000, signal });
  if (!signal?.aborted) ghAvailable = output !== null;
  return output !== null;
}

export function showGhHint(): void {
  if (ghHintShown) return;
  ghHintShown = true;
  console.error(
    "[pi-web-access] Install gh for private repositories and GitHub API fallback.",
  );
}

export async function checkRepoSize(
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<number | null> {
  if (await checkGhAvailable(signal)) {
    const output = await runGh(
      ["api", `repos/${owner}/${repo}`, "--jq", ".size"],
      { timeoutMs: 10_000, signal },
    );
    if (output) {
      const size = Number.parseInt(output.trim(), 10);
      if (!Number.isNaN(size)) return size;
    }
  }

  try {
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "pi-web-access",
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { size?: unknown };
    return typeof data.size === "number" && Number.isFinite(data.size)
      ? data.size
      : null;
  } catch {
    return null;
  }
}

async function defaultBranch(
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!(await checkGhAvailable(signal))) return null;
  const output = await runGh(
    ["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"],
    { timeoutMs: 10_000, signal },
  );
  return output?.trim() || null;
}

async function tree(
  owner: string,
  repo: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const output = await runGh(
    [
      "api",
      `repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
      "--jq",
      ".tree[].path",
    ],
    { timeoutMs: 15_000, maxBuffer: 5 * 1024 * 1024, signal },
  );
  if (!output?.trim()) return null;
  const paths = output.trim().split("\n");
  const visible = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
  return paths.length > MAX_TREE_ENTRIES
    ? `${visible}\n... (${paths.length} total entries)`
    : visible;
}

async function readme(
  owner: string,
  repo: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const output = await runGh(
    ["api", `repos/${owner}/${repo}/readme?ref=${ref}`, "--jq", ".content"],
    { timeoutMs: 10_000, signal },
  );
  if (!output) return null;
  const content = Buffer.from(output.trim(), "base64").toString("utf8");
  return content.slice(0, 8_192);
}

async function file(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const output = await runGh(
    [
      "api",
      `repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
      "--jq",
      ".content",
    ],
    { timeoutMs: 10_000, signal },
  );
  return output ? Buffer.from(output.trim(), "base64").toString("utf8") : null;
}

export async function fetchViaApi(
  url: string,
  owner: string,
  repo: string,
  info: GitHubUrlInfo,
  sizeNote?: string,
  signal?: AbortSignal,
): Promise<ExtractedContent | null> {
  if (!(await checkGhAvailable(signal))) return null;
  const ref = info.ref || (await defaultBranch(owner, repo, signal));
  if (!ref || signal?.aborted) return null;

  const lines = sizeNote ? [sizeNote, ""] : [];
  if (info.type === "blob" && info.path) {
    const content = await file(owner, repo, info.path, ref, signal);
    if (!content) return null;
    lines.push(`## ${info.path}`, content.slice(0, MAX_CONTENT_CHARS));
    return {
      url,
      title: `${owner}/${repo} - ${info.path}`,
      content: lines.join("\n").slice(0, MAX_CONTENT_CHARS),
      error: null,
    };
  }

  const [structure, repositoryReadme] = await Promise.all([
    tree(owner, repo, ref, signal),
    readme(owner, repo, ref, signal),
  ]);
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
}
