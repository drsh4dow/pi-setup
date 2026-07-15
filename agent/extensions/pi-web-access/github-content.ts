import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, join, sep as pathSeparator, resolve } from "node:path";
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

function isBinaryFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;

  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(512);
    const bytesRead = readSync(fd, buf, 0, 512, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }

  return false;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveWithinRepo(
  rootPath: string,
  relativePath: string,
): string | null {
  const normalizedRoot = resolve(rootPath);
  const candidate = resolve(normalizedRoot, relativePath);
  if (candidate !== normalizedRoot) {
    const rootPrefix = normalizedRoot.endsWith(pathSeparator)
      ? normalizedRoot
      : normalizedRoot + pathSeparator;
    if (!candidate.startsWith(rootPrefix)) return null;
  }

  if (!existsSync(candidate)) return candidate;

  try {
    const realRoot = realpathSync(normalizedRoot);
    const realCandidate = realpathSync(candidate);
    if (realCandidate === realRoot) return candidate;
    const realRootPrefix = realRoot.endsWith(pathSeparator)
      ? realRoot
      : realRoot + pathSeparator;
    return realCandidate.startsWith(realRootPrefix) ? candidate : null;
  } catch {
    return null;
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function buildTree(rootPath: string): string {
  const entries: string[] = [];

  function walk(dir: string, relPath: string): void {
    if (entries.length >= MAX_TREE_ENTRIES) return;

    let items: string[];
    try {
      items = readdirSync(dir).sort();
    } catch {
      return;
    }

    for (const item of items) {
      if (entries.length >= MAX_TREE_ENTRIES) return;
      if (item === ".git") continue;

      const rel = relPath ? `${relPath}/${item}` : item;
      const safePath = resolveWithinRepo(rootPath, rel);
      if (!safePath) {
        entries.push(`${rel}  [outside repo skipped]`);
        continue;
      }

      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(safePath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (NOISE_DIRS.has(item)) {
          entries.push(`${rel}/  [skipped]`);
          continue;
        }
        entries.push(`${rel}/`);
        walk(safePath, rel);
      } else {
        entries.push(rel);
      }
    }
  }

  walk(rootPath, "");

  if (entries.length >= MAX_TREE_ENTRIES) {
    entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
  }

  return entries.join("\n");
}

function buildDirListing(rootPath: string, subPath: string): string {
  const targetPath = resolveWithinRepo(rootPath, subPath);
  if (!targetPath) return "(path escapes repository root)";
  const lines: string[] = [];

  let items: string[];
  try {
    items = readdirSync(targetPath).sort();
  } catch {
    return "(directory not readable)";
  }

  for (const item of items) {
    if (item === ".git") continue;
    const rel = subPath ? `${subPath}/${item}` : item;
    const safePath = resolveWithinRepo(rootPath, rel);
    if (!safePath) {
      lines.push(`  ${item}  (outside repo)`);
      continue;
    }
    try {
      const stat = statSync(safePath);
      if (stat.isDirectory()) {
        lines.push(`  ${item}/`);
      } else {
        lines.push(`  ${item}  (${formatFileSize(stat.size)})`);
      }
    } catch {
      lines.push(`  ${item}  (unreadable)`);
    }
  }

  return lines.join("\n");
}

function readReadme(localPath: string): string | null {
  const candidates = [
    "README.md",
    "readme.md",
    "README",
    "README.txt",
    "README.rst",
  ];
  for (const name of candidates) {
    const readmePath = join(localPath, name);
    if (existsSync(readmePath)) {
      try {
        const content = readFileSync(readmePath, "utf-8");
        return content.length > 8192
          ? `${content.slice(0, 8192)}\n\n[README truncated at 8K chars]`
          : content;
      } catch {}
    }
  }
  return null;
}

export function renderCloneContent(
  localPath: string,
  info: GitHubUrlInfo,
): string {
  const lines: string[] = [];
  lines.push(`Repository cloned to: ${localPath}`);
  lines.push("");

  if (info.type === "root") {
    lines.push("## Structure");
    lines.push(buildTree(localPath));
    lines.push("");

    const readme = readReadme(localPath);
    if (readme) {
      lines.push("## README.md");
      lines.push(readme);
      lines.push("");
    }

    lines.push(
      "Use `read` and `bash` tools at the path above to explore further.",
    );
    return lines.join("\n");
  }

  if (info.type === "tree") {
    const dirPath = info.path || "";
    const fullDirPath = resolveWithinRepo(localPath, dirPath);

    if (!fullDirPath || !existsSync(fullDirPath)) {
      lines.push(
        `Path \`${dirPath}\` not found in clone. Showing repository root instead.`,
      );
      lines.push("");
      lines.push("## Structure");
      lines.push(buildTree(localPath));
    } else {
      lines.push(`## ${dirPath || "/"}`);
      lines.push(buildDirListing(localPath, dirPath));
    }

    lines.push("");
    lines.push(
      "Use `read` and `bash` tools at the path above to explore further.",
    );
    return lines.join("\n");
  }

  if (info.type === "blob") {
    const filePath = info.path || "";
    const fullFilePath = resolveWithinRepo(localPath, filePath);

    if (!fullFilePath || !existsSync(fullFilePath)) {
      lines.push(
        `Path \`${filePath}\` not found in clone. Showing repository root instead.`,
      );
      lines.push("");
      lines.push("## Structure");
      lines.push(buildTree(localPath));
      lines.push("");
      lines.push(
        "Use `read` and `bash` tools at the path above to explore further.",
      );
      return lines.join("\n");
    }

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullFilePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lines.push(`Could not inspect \`${filePath}\`: ${message}`);
      lines.push("");
      lines.push(
        "Use `read` and `bash` tools at the path above to explore further.",
      );
      return lines.join("\n");
    }

    if (stat.isDirectory()) {
      lines.push(`## ${filePath || "/"}`);
      lines.push(buildDirListing(localPath, filePath));
      lines.push("");
      lines.push(
        "Use `read` and `bash` tools at the path above to explore further.",
      );
      return lines.join("\n");
    }

    if (isBinaryFile(fullFilePath)) {
      const ext = extname(filePath).replace(".", "");
      lines.push(`## ${filePath}`);
      lines.push(
        `Binary file (${ext}, ${formatFileSize(stat.size)}). Use \`read\` or \`bash\` tools at the path above to inspect.`,
      );
      return lines.join("\n");
    }

    const content = readTextFile(fullFilePath);
    if (content === null) {
      lines.push(`Could not read \`${filePath}\` as UTF-8 text.`);
      lines.push("");
      lines.push(
        "Use `read` and `bash` tools at the path above to explore further.",
      );
      return lines.join("\n");
    }
    lines.push(`## ${filePath}`);

    if (content.length > MAX_INLINE_FILE_CHARS) {
      lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
      lines.push("");
      lines.push(`[File truncated at 100K chars. Full file: ${fullFilePath}]`);
    } else {
      lines.push(content);
    }

    lines.push("");
    lines.push(
      "Use `read` and `bash` tools at the path above to explore further.",
    );
    return lines.join("\n");
  }

  return lines.join("\n");
}
