import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkGhAvailable,
  checkRepoSize,
  fetchViaApi,
  showGhHint,
} from "./github-api.ts";
import { renderCloneContent } from "./github-content.ts";
import type { ExtractedContent } from "./types.ts";

const MAX_REPO_SIZE_MB = 350;
const MAX_CACHED_CLONES = 10;
const CLONE_TIMEOUT_MS = 30_000;
const CLONE_ROOT = join(tmpdir(), "pi-web-access-repos", String(process.pid));

export interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  refIsFullSha: boolean;
  path?: string;
  type: "root" | "blob" | "tree";
}

interface CachedClone {
  localPath: string;
  clonePromise: Promise<string | null>;
}

const cloneCache = new Map<string, CachedClone>();

const NON_CODE_SEGMENTS = new Set([
  "issues",
  "pull",
  "pulls",
  "discussions",
  "releases",
  "wiki",
  "actions",
  "settings",
  "security",
  "projects",
  "graphs",
  "compare",
  "commits",
  "tags",
  "branches",
  "stargazers",
  "watchers",
  "network",
  "forks",
  "milestone",
  "labels",
  "packages",
  "codespaces",
  "contribute",
  "community",
  "sponsors",
  "invitations",
  "notifications",
  "insights",
]);

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");

  if (NON_CODE_SEGMENTS.has(segments[2]?.toLowerCase())) return null;

  if (segments.length === 2) {
    return { owner, repo, refIsFullSha: false, type: "root" };
  }

  const action = segments[2];
  if (action !== "blob" && action !== "tree") return null;
  if (segments.length < 4) return null;

  const ref = segments[3];
  const refIsFullSha = /^[0-9a-f]{40}$/.test(ref);
  const pathParts = segments.slice(4);
  const path = pathParts.length > 0 ? pathParts.join("/") : "";

  return {
    owner,
    repo,
    ref,
    refIsFullSha,
    path,
    type: action as "blob" | "tree",
  };
}

function cacheKey(owner: string, repo: string, ref?: string): string {
  return ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
}

function cloneDir(owner: string, repo: string, ref?: string): string {
  const dirName = ref ? `${repo}@${ref}` : repo;
  return join(CLONE_ROOT, owner, dirName);
}

function execClone(
  args: string[],
  localPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolvePromise) => {
    execFile(
      args[0],
      args.slice(1),
      { timeout: CLONE_TIMEOUT_MS, signal },
      (error) => {
        if (error) {
          try {
            rmSync(localPath, { recursive: true, force: true });
          } catch {
            // The original clone failure is the useful error path.
          }
          resolvePromise(null);
          return;
        }
        resolvePromise(localPath);
      },
    );
  });
}

async function cloneRepo(
  owner: string,
  repo: string,
  ref: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  const localPath = cloneDir(owner, repo, ref);
  try {
    rmSync(localPath, { recursive: true, force: true });
  } catch {
    return null;
  }
  const hasGh = await checkGhAvailable(signal);

  if (hasGh) {
    const args = [
      "gh",
      "repo",
      "clone",
      `${owner}/${repo}`,
      localPath,
      "--",
      "--depth",
      "1",
      "--single-branch",
    ];
    if (ref) args.push("--branch", ref);
    return execClone(args, localPath, signal);
  }

  showGhHint();
  const args = ["git", "clone", "--depth", "1", "--single-branch"];
  if (ref) args.push("--branch", ref);
  args.push(`https://github.com/${owner}/${repo}.git`, localPath);
  return execClone(args, localPath, signal);
}

async function awaitCachedClone(
  cached: CachedClone,
  url: string,
  owner: string,
  repo: string,
  info: GitHubUrlInfo,
  signal?: AbortSignal,
): Promise<ExtractedContent | null> {
  if (signal?.aborted) return null;
  const result = await cached.clonePromise;
  if (signal?.aborted) return null;
  if (result) {
    const content = renderCloneContent(result, info).slice(0, 100_000);
    const title = info.path
      ? `${owner}/${repo} - ${info.path}`
      : `${owner}/${repo}`;
    return { url, title, content, error: null };
  }
  return fetchViaApi(url, owner, repo, info, undefined, signal);
}

export async function extractGitHub(
  url: string,
  signal?: AbortSignal,
  forceClone = false,
): Promise<ExtractedContent | null> {
  const info = parseGitHubUrl(url);
  if (!info) return null;
  if (signal?.aborted) {
    return { url, title: "", content: "", error: "Aborted" };
  }

  const { owner, repo } = info;
  const key = cacheKey(owner, repo, info.ref);
  const cached = cloneCache.get(key);
  if (cached) {
    return (
      (await awaitCachedClone(cached, url, owner, repo, info, signal)) ?? {
        url,
        title: "",
        content: "",
        error: "GitHub clone and API fallback failed",
      }
    );
  }

  if (info.refIsFullSha) {
    return (
      (await fetchViaApi(
        url,
        owner,
        repo,
        info,
        "Note: Commit SHA URLs use the GitHub API instead of cloning.",
        signal,
      )) ?? {
        url,
        title: "",
        content: "",
        error: "GitHub API access failed for this commit",
      }
    );
  }

  if (!forceClone) {
    const sizeKB = await checkRepoSize(owner, repo, signal);
    if (signal?.aborted) {
      return { url, title: "", content: "", error: "Aborted" };
    }
    if (sizeKB === null) {
      return {
        url,
        title: "",
        content: "",
        error:
          "Could not determine repository size. Use forceClone: true to clone explicitly.",
      };
    }
    if (sizeKB / 1024 > MAX_REPO_SIZE_MB) {
      const note =
        `Note: Repository is ${Math.round(sizeKB / 1024)}MB ` +
        `(threshold: ${MAX_REPO_SIZE_MB}MB). Showing the API view. ` +
        "Call fetch_content with forceClone: true to bypass the size check.";
      return (
        (await fetchViaApi(url, owner, repo, info, note, signal)) ?? {
          url,
          title: "",
          content: "",
          error:
            "Repository exceeds the clone threshold and its API view failed",
        }
      );
    }
  }

  const concurrentClone = cloneCache.get(key);
  if (concurrentClone) {
    return (
      (await awaitCachedClone(
        concurrentClone,
        url,
        owner,
        repo,
        info,
        signal,
      )) ?? {
        url,
        title: "",
        content: "",
        error: "GitHub clone and API fallback failed",
      }
    );
  }

  while (cloneCache.size >= MAX_CACHED_CLONES) {
    const oldestKey = cloneCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = cloneCache.get(oldestKey);
    if (oldest) {
      try {
        rmSync(oldest.localPath, { recursive: true, force: true });
      } catch {
        // A failed eviction must not make the new request fail.
      }
    }
    cloneCache.delete(oldestKey);
  }

  const clonePromise = cloneRepo(owner, repo, info.ref, signal);
  const localPath = cloneDir(owner, repo, info.ref);
  cloneCache.set(key, { localPath, clonePromise });
  const result = await clonePromise;

  if (signal?.aborted) {
    if (!result) cloneCache.delete(key);
    return { url, title: "", content: "", error: "Aborted" };
  }
  if (!result) {
    cloneCache.delete(key);
    return (
      (await fetchViaApi(url, owner, repo, info, undefined, signal)) ?? {
        url,
        title: "",
        content: "",
        error: "GitHub clone and API fallback failed",
      }
    );
  }

  const content = renderCloneContent(result, info).slice(0, 100_000);
  const title = info.path
    ? `${owner}/${repo} - ${info.path}`
    : `${owner}/${repo}`;
  return { url, title, content, error: null };
}

export function clearCloneCache(): void {
  for (const entry of cloneCache.values()) {
    try {
      rmSync(entry.localPath, { recursive: true, force: true });
    } catch {
      // Temporary clone cleanup is best-effort during process teardown.
    }
  }
  cloneCache.clear();
}
