import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Path } from "effect";
import type { GitHubUrlInfo } from "./github.ts";

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
const MAX_INLINE_FILE_CHARS = 100_000;
const MAX_TREE_ENTRIES = 200;

function formatFileSize(bytes: bigint): string {
	const size = Number(bytes);
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export const renderCloneContent = Effect.fn("renderCloneContent")(
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
			content.length > MAX_INLINE_FILE_CHARS
				? `${content.slice(0, MAX_INLINE_FILE_CHARS)}\n\n[File truncated at 100K chars. Full file: ${target}]`
				: content,
			"",
			explorationHint,
		);
		return lines.join("\n");
	},
	Effect.provide([BunFileSystem.layer, BunPath.layer]),
);
