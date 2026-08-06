import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Config, Effect, FileSystem, Path, Schema } from "effect";
import {
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";
import { asError, type WebAccessError } from "./errors.ts";
import { runCommand } from "./subprocess.ts";
import type { ExtractedContent } from "./types.ts";

const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));

const MAX_REPO_SIZE_MB = 350;
const MAX_CACHED_CLONES = 10;
const CLONE_TIMEOUT_MS = 30_000;
const MAX_TREE_ENTRIES = 200;
const MAX_CONTENT_CHARS = 100_000;

interface GitHubUrlInfo {
	owner: string;
	repo: string;
	ref?: string;
	refIsFullSha: boolean;
	path?: string;
	type: "root" | "blob" | "tree";
}

interface CachedClone {
	localPath: string;
	clone: Effect.Effect<string | null, WebAccessError>;
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

	// Decoded segments feed path.join for the clone directory, which removeClone
	// deletes recursively; traversal sequences must never reach it.
	const unsafeSegment = (segment: string) =>
		segment === "." ||
		segment === ".." ||
		/[/\\\0]/.test(segment) ||
		segment.startsWith("~");
	if (segments.some(unsafeSegment)) return null;

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

const GitHubRepositoryResponse = Schema.Struct({
	size: Schema.optionalKey(Schema.Finite),
});
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

const checkGhAvailable: Effect.Effect<boolean> = Effect.suspend(() => {
	if (ghAvailable !== null) return Effect.succeed(ghAvailable);
	return runGh(["--version"], { timeoutMs: 5_000 }).pipe(
		Effect.map((output) => {
			ghAvailable = output !== null;
			return ghAvailable;
		}),
	);
});

function showGhHint(): void {
	if (ghHintShown) return;
	ghHintShown = true;
	Effect.runSync(
		Effect.logWarning(
			"[pi-web-access] Install gh for private repositories and GitHub API fallback.",
		),
	);
}

const checkRepoSize: (
	owner: string,
	repo: string,
) => Effect.Effect<number | null> = Effect.fn("checkRepoSize")(function* (
	owner: string,
	repo: string,
) {
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
		const client = yield* HttpClient.HttpClient;
		const request = HttpClientRequest.get(
			`https://api.github.com/repos/${owner}/${repo}`,
		).pipe(
			HttpClientRequest.setHeaders({
				Accept: "application/vnd.github+json",
				"User-Agent": "pi-web-access",
			}),
		);
		const response = yield* client
			.execute(request)
			.pipe(Effect.timeout(10_000), Effect.mapError(asError));
		if (response.status < 200 || response.status >= 300) return null;
		const data = yield* HttpClientResponse.schemaBodyJson(
			GitHubRepositoryResponse,
		)(response).pipe(Effect.mapError(asError));
		return data.size ?? null;
	}).pipe(Effect.orElseSucceed(() => null));
}, Effect.provide(BunHttpClient.layer));

const defaultBranch = Effect.fn("defaultBranch")(function* (
	owner: string,
	repo: string,
) {
	if (!(yield* checkGhAvailable)) return null;
	const output = yield* runGh(
		["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"],
		{ timeoutMs: 10_000 },
	);
	return output?.trim() || null;
});

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

export const fetchViaApi = Effect.fn("fetchViaApi")(function* (
	url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
	sizeNote?: string,
) {
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

const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".bmp",
	".ico",
	".webp",
	".svg",
	".tiff",
	".tif",
	".mp3",
	".mp4",
	".avi",
	".mov",
	".mkv",
	".flv",
	".wmv",
	".wav",
	".ogg",
	".webm",
	".flac",
	".aac",
	".zip",
	".tar",
	".gz",
	".bz2",
	".xz",
	".7z",
	".rar",
	".zst",
	".exe",
	".dll",
	".so",
	".dylib",
	".bin",
	".o",
	".a",
	".lib",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".sqlite",
	".db",
	".sqlite3",
	".pyc",
	".pyo",
	".class",
	".jar",
	".war",
	".iso",
	".img",
	".dmg",
]);
const NOISE_DIRS = new Set([
	"node_modules",
	"vendor",
	".next",
	"dist",
	"build",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".mypy_cache",
	".pytest_cache",
	"target",
	".gradle",
	".idea",
	".vscode",
]);

function formatFileSize(bytes: bigint): string {
	const size = Number(bytes);
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const renderCloneContent = Effect.fn("renderCloneContent")(
	function* (localPath: string, info: GitHubUrlInfo) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = path.resolve(localPath);
		const realRoot = yield* fs.realPath(root);
		const resolveWithinRepo = Effect.fn("resolveWithinRepo")(function* (
			relativePath: string,
		) {
			const candidate = path.resolve(root, relativePath);
			if (
				candidate !== root &&
				!candidate.startsWith(
					root.endsWith(path.sep) ? root : `${root}${path.sep}`,
				)
			)
				return null;
			if (!(yield* fs.exists(candidate))) return candidate;
			const realCandidate = yield* fs
				.realPath(candidate)
				.pipe(Effect.orElseSucceed(() => ""));
			return realCandidate === realRoot ||
				realCandidate.startsWith(
					realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`,
				)
				? candidate
				: null;
		});
		const buildListing = Effect.fn("buildListing")(function* (subPath: string) {
			const target = yield* resolveWithinRepo(subPath);
			if (!target) return "(path escapes repository root)";
			const items = yield* fs.readDirectory(target).pipe(
				Effect.map((items) => items.sort()),
				Effect.orElseSucceed(() => null),
			);
			if (!items) return "(directory not readable)";
			const lines: string[] = [];
			for (const item of items) {
				if (item === ".git") continue;
				const rel = subPath ? `${subPath}/${item}` : item;
				const safe = yield* resolveWithinRepo(rel);
				if (!safe) {
					lines.push(`  ${item}  (outside repo)`);
					continue;
				}
				const stat = yield* fs
					.stat(safe)
					.pipe(Effect.orElseSucceed(() => null));
				if (!stat) lines.push(`  ${item}  (unreadable)`);
				else if (stat.type === "Directory") lines.push(`  ${item}/`);
				else lines.push(`  ${item}  (${formatFileSize(stat.size)})`);
			}
			return lines.join("\n");
		});
		const buildTree = Effect.fn("buildTree")(function* () {
			const entries: string[] = [];
			const pending: Array<{ dir: string; rel: string }> = [
				{ dir: root, rel: "" },
			];
			while (pending.length > 0 && entries.length < MAX_TREE_ENTRIES) {
				const current = pending.pop();
				if (!current) break;
				const items = yield* fs.readDirectory(current.dir).pipe(
					Effect.map((items) => items.sort()),
					Effect.orElseSucceed(() => []),
				);
				for (const item of items) {
					if (entries.length >= MAX_TREE_ENTRIES) break;
					if (item === ".git") continue;
					const rel = current.rel ? `${current.rel}/${item}` : item;
					const safe = yield* resolveWithinRepo(rel);
					if (!safe) {
						entries.push(`${rel}  [outside repo skipped]`);
						continue;
					}
					const stat = yield* fs
						.stat(safe)
						.pipe(Effect.orElseSucceed(() => null));
					if (!stat) continue;
					if (stat.type === "Directory") {
						if (NOISE_DIRS.has(item)) entries.push(`${rel}/  [skipped]`);
						else {
							entries.push(`${rel}/`);
							pending.push({ dir: safe, rel });
						}
					} else entries.push(rel);
				}
			}
			if (entries.length >= MAX_TREE_ENTRIES)
				entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
			return entries.join("\n");
		});

		const lines = [`Repository cloned to: ${localPath}`, ""];
		const explorationHint =
			"Use `read` and `bash` tools at the path above to explore further.";
		if (info.type === "root") {
			lines.push("## Structure", yield* buildTree(), "");
			for (const name of [
				"README.md",
				"readme.md",
				"README",
				"README.txt",
				"README.rst",
			]) {
				const readme = path.join(root, name);
				if (!(yield* fs.exists(readme))) continue;
				const content = yield* fs
					.readFileString(readme)
					.pipe(Effect.orElseSucceed(() => ""));
				if (content)
					lines.push(
						"## README.md",
						content.length > 8192
							? `${content.slice(0, 8192)}\n\n[README truncated at 8K chars]`
							: content,
						"",
					);
				break;
			}
			lines.push(explorationHint);
			return lines.join("\n");
		}
		const relative = info.path || "";
		const target = yield* resolveWithinRepo(relative);
		if (!target || !(yield* fs.exists(target))) {
			lines.push(
				`Path \`${relative}\` not found in clone. Showing repository root instead.`,
				"",
				"## Structure",
				yield* buildTree(),
				"",
				explorationHint,
			);
			return lines.join("\n");
		}
		const stat = yield* fs.stat(target);
		if (info.type === "tree" || stat.type === "Directory") {
			lines.push(
				`## ${relative || "/"}`,
				yield* buildListing(relative),
				"",
				explorationHint,
			);
			return lines.join("\n");
		}
		const bytes = yield* fs
			.readFile(target)
			.pipe(Effect.orElseSucceed(() => null));
		if (!bytes) {
			lines.push(
				`Could not read \`${relative}\` as UTF-8 text.`,
				"",
				explorationHint,
			);
			return lines.join("\n");
		}
		const binary =
			BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase()) ||
			bytes.subarray(0, 512).some((byte) => byte === 0);
		lines.push(`## ${relative}`);
		if (binary) {
			lines.push(
				`Binary file (${path.extname(relative).replace(".", "")}, ${formatFileSize(stat.size)}). Use \`read\` or \`bash\` tools at the path above to inspect.`,
			);
			return lines.join("\n");
		}
		const content = new TextDecoder().decode(bytes);
		lines.push(
			content.length > MAX_CONTENT_CHARS
				? `${content.slice(0, MAX_CONTENT_CHARS)}\n\n[File truncated at 100K chars. Full file: ${target}]`
				: content,
			"",
			explorationHint,
		);
		return lines.join("\n");
	},
	Effect.provide([BunFileSystem.layer, BunPath.layer]),
);

const cloneDir = Effect.fn("cloneDir")(function* (
	owner: string,
	repo: string,
	ref?: string,
) {
	const tempDirectory = yield* Config.string("TMPDIR").pipe(
		Config.withDefault("/tmp"),
		Effect.mapError(asError),
	);
	const dirName = ref ? `${repo}@${ref}` : repo;
	return path.join(
		tempDirectory,
		"pi-web-access-repos",
		String(process.pid),
		owner,
		dirName,
	);
});

const removeClone = Effect.fn("removeClone")(function* (localPath: string) {
	const fs = yield* FileSystem.FileSystem;
	return yield* fs.remove(localPath, { recursive: true, force: true }).pipe(
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	);
}, Effect.provide(BunFileSystem.layer));

const cloneRepo = Effect.fn("cloneRepo")(function* (
	owner: string,
	repo: string,
	ref: string | undefined,
) {
	const localPath = yield* cloneDir(owner, repo, ref);
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
			const content = rendered.slice(0, MAX_CONTENT_CHARS);
			const title = info.path
				? `${owner}/${repo} - ${info.path}`
				: `${owner}/${repo}`;
			return { url, title, content, error: null };
		}),
		Effect.mapError(asError),
	);
}

const awaitCachedClone = Effect.fn("awaitCachedClone")(function* (
	cached: CachedClone,
	url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
) {
	const result = yield* cloneResult(
		yield* cached.clone,
		url,
		owner,
		repo,
		info,
	);
	return result ?? (yield* fetchViaApi(url, owner, repo, info));
});

function failed(url: string, error: string): ExtractedContent {
	return { url, title: "", content: "", error };
}

export const extractGitHub = Effect.fn("extractGitHub")(function* (
	url: string,
	forceClone = false,
) {
	const info = parseGitHubUrl(url);
	if (!info) return null;

	const { owner, repo } = info;
	const key = info.ref ? `${owner}/${repo}@${info.ref}` : `${owner}/${repo}`;
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
	const localPath = yield* cloneDir(owner, repo, info.ref);
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

export const clearCloneCache: Effect.Effect<void> = Effect.gen(function* () {
	for (const entry of cloneCache.values()) yield* removeClone(entry.localPath);
	cloneCache.clear();
});
