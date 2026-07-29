import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Path } from "effect";
import { asError, type WebAccessError } from "./errors.ts";
import {
	checkGhAvailable,
	checkRepoSize,
	fetchViaApi,
	showGhHint,
} from "./github-api.ts";
import { renderCloneContent } from "./github-content.ts";
import { runCommand } from "./subprocess.ts";
import type { ExtractedContent } from "./types.ts";

const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));

const MAX_REPO_SIZE_MB = 350;
const MAX_CACHED_CLONES = 10;
const CLONE_TIMEOUT_MS = 30_000;
const CLONE_ROOT = path.join(
	process.env.TMPDIR ?? "/tmp",
	"pi-web-access-repos",
	String(process.pid),
);

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
	clone: Effect.Effect<string | null>;
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
		type: action,
	};
}

function cacheKey(owner: string, repo: string, ref?: string): string {
	return ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
}

function cloneDir(owner: string, repo: string, ref?: string): string {
	const dirName = ref ? `${repo}@${ref}` : repo;
	return path.join(CLONE_ROOT, owner, dirName);
}

const removeClone = Effect.fn("removeClone")(function* (localPath: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* fs.remove(localPath, { recursive: true, force: true }).pipe(
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	);
}, Effect.provide(BunFileSystem.layer));

function cloneRepo(
	owner: string,
	repo: string,
	ref: string | undefined,
): Effect.Effect<string | null> {
	return Effect.gen(function* () {
		const localPath = cloneDir(owner, repo, ref);
		if (!(yield* removeClone(localPath))) return null;
		const hasGh = yield* checkGhAvailable;
		const args = hasGh
			? [
					"gh",
					"repo",
					"clone",
					`${owner}/${repo}`,
					localPath,
					"--",
					"--depth",
					"1",
					"--single-branch",
				]
			: ["git", "clone", "--depth", "1", "--single-branch"];
		if (ref) args.push("--branch", ref);
		if (!hasGh) {
			showGhHint();
			args.push(`https://github.com/${owner}/${repo}.git`, localPath);
		}

		return yield* runCommand(args[0], args.slice(1), {
			timeoutMs: CLONE_TIMEOUT_MS,
			maxBuffer: 2 * 1024 * 1024,
		}).pipe(
			Effect.as(localPath),
			Effect.catch(() => removeClone(localPath).pipe(Effect.as(null))),
		);
	});
}

function cloneResult(
	result: string | null,
	url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
): Effect.Effect<ExtractedContent | null, WebAccessError> {
	if (!result) return Effect.succeed(null);
	return renderCloneContent(result, info).pipe(
		Effect.map((rendered) => {
			const content = rendered.slice(0, 100_000);
			const title = info.path
				? `${owner}/${repo} - ${info.path}`
				: `${owner}/${repo}`;
			return { url, title, content, error: null };
		}),
		Effect.mapError(asError),
	);
}

function awaitCachedClone(
	cached: CachedClone,
	url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
): Effect.Effect<ExtractedContent | null, WebAccessError> {
	return Effect.gen(function* () {
		const result = yield* cloneResult(
			yield* cached.clone,
			url,
			owner,
			repo,
			info,
		);
		return result ?? (yield* fetchViaApi(url, owner, repo, info));
	});
}

function failed(url: string, error: string): ExtractedContent {
	return { url, title: "", content: "", error };
}

export function extractGitHub(
	url: string,
	forceClone = false,
): Effect.Effect<ExtractedContent | null, WebAccessError> {
	return Effect.gen(function* () {
		const info = parseGitHubUrl(url);
		if (!info) return null;

		const { owner, repo } = info;
		const key = cacheKey(owner, repo, info.ref);
		const cached = cloneCache.get(key);
		if (cached) {
			return (
				(yield* awaitCachedClone(cached, url, owner, repo, info)) ??
				failed(url, "GitHub clone and API fallback failed")
			);
		}

		if (info.refIsFullSha) {
			return (
				(yield* fetchViaApi(
					url,
					owner,
					repo,
					info,
					"Note: Commit SHA URLs use the GitHub API instead of cloning.",
				)) ?? failed(url, "GitHub API access failed for this commit")
			);
		}

		if (!forceClone) {
			const sizeKB = yield* checkRepoSize(owner, repo);
			if (sizeKB === null) {
				return failed(
					url,
					"Could not determine repository size. Use forceClone: true to clone explicitly.",
				);
			}
			if (sizeKB / 1024 > MAX_REPO_SIZE_MB) {
				const note =
					`Note: Repository is ${Math.round(sizeKB / 1024)}MB ` +
					`(threshold: ${MAX_REPO_SIZE_MB}MB). Showing the API view. ` +
					"Call fetch_content with forceClone: true to bypass the size check.";
				return (
					(yield* fetchViaApi(url, owner, repo, info, note)) ??
					failed(
						url,
						"Repository exceeds the clone threshold and its API view failed",
					)
				);
			}
		}

		const concurrentClone = cloneCache.get(key);
		if (concurrentClone) {
			return (
				(yield* awaitCachedClone(concurrentClone, url, owner, repo, info)) ??
				failed(url, "GitHub clone and API fallback failed")
			);
		}

		while (cloneCache.size >= MAX_CACHED_CLONES) {
			const oldestKey = cloneCache.keys().next().value;
			if (!oldestKey) break;
			const oldest = cloneCache.get(oldestKey);
			if (oldest) yield* removeClone(oldest.localPath);
			cloneCache.delete(oldestKey);
		}

		const clone = yield* Effect.cached(cloneRepo(owner, repo, info.ref));
		const localPath = cloneDir(owner, repo, info.ref);
		cloneCache.set(key, { localPath, clone });
		const result = yield* clone;
		if (!result) {
			cloneCache.delete(key);
			return (
				(yield* fetchViaApi(url, owner, repo, info)) ??
				failed(url, "GitHub clone and API fallback failed")
			);
		}
		return yield* cloneResult(result, url, owner, repo, info);
	});
}

export const clearCloneCache: Effect.Effect<void> = Effect.gen(function* () {
	for (const entry of cloneCache.values()) yield* removeClone(entry.localPath);
	cloneCache.clear();
});
