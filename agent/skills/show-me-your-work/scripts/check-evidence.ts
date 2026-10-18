#!/usr/bin/env node
// Print each path or file:line in a decision log's evidence column that does
// not resolve. A relative path resolves from the log's directory, the current
// git repository root, the working directory, or a directory that an earlier
// pointer in the same cell names or sits in, and that directory's parent. A
// bare file name also resolves to any file with that name that the repository
// tracks or that sits in the log's directory or one level below it.
// Usage: check-evidence.ts <logfile> [first-line]
// Checks the rows from log line first-line on, or every row without it.
// Exit: 0 all resolve, 1 some do not, 64 bad argument or a check that cannot run.

// Without import statements the file runs as CommonJS or as an ES module, so a
// copy of the skill under any package.json runs without a warning.
const { spawnSync } = process.getBuiltinModule("node:child_process");
const { closeSync, existsSync, globSync, openSync, readdirSync, readFileSync, readSync, statSync } =
  process.getBuiltinModule("node:fs");
const { homedir } = process.getBuiltinModule("node:os");
const { basename, dirname, join, resolve } = process.getBuiltinModule("node:path");

const fileExtensions = new Set(
  `md txt json jsonc yaml yml toml tsv csv log sh ts tsx mts cts js mjs cjs jsx py go rs c h cc cpp
  hpp tla cfg ini xml css html sql diff patch map lock png jpg jpeg gif webp svg pdf mov mp4 webm
  cpuprofile heapsnapshot heapprofile trace`.split(/\s+/),
);

const lineSuffixes = [
  /^(.+):(\d+):\d+$/,
  /^(.+):(\d+)$/,
  /^(.+)#L(\d+)$/,
  /^(.+):(\d+)-(\d+)$/,
  /^(.+)#L(\d+)-L(\d+)$/,
];

class Failure {
  readonly message: string;

  constructor(message: string) {
    this.message = message;
  }
}

type Arguments = { logfile: string; firstLine: number };

type Row = { lineno: number; cell: string };

type LineRange = { start: number; end: number };

type Pointer = { token: string; path: string; lines: LineRange | undefined };

type Location = { directory: string; path: string };

type Search = {
  bases: readonly string[];
  filesByName: ReadonlyMap<string, readonly string[]>;
};

type Finding = { lineno: number; token: string; reason: string };

function parseArguments(argv: readonly string[]): Arguments | Failure {
  const [logfile, firstLine = "1"] = argv;

  if (logfile === undefined || argv.length > 2) {
    return new Failure("expected arguments <logfile> [first-line]");
  }

  if (!/^[1-9]\d*$/.test(firstLine)) {
    return new Failure(`first-line must be a positive line number, got ${firstLine}`);
  }

  return { logfile, firstLine: Number(firstLine) };
}

function readLog(logfile: string): string | Failure {
  try {
    if (!statSync(logfile).isFile()) {
      return new Failure(`cannot read ${logfile}, it is not a regular file`);
    }

    return readFileSync(logfile, "utf8");
  } catch (error) {
    return new Failure(`cannot read ${logfile}: ${errorMessage(error)}`);
  }
}

function parseRows(logfile: string, log: string, firstLine: number): Row[] | Failure {
  const lines = log.split("\n").map((line) => line.replace(/\r$/, ""));
  const column = (lines[0] ?? "").split("\t").lastIndexOf("evidence");

  if (column === -1) {
    return new Failure(`${logfile} has no evidence column in its header row`);
  }

  const rows: Row[] = [];

  for (let index = Math.max(firstLine - 1, 1); index < lines.length; index++) {
    const cell = lines[index]?.split("\t")[column];

    if (cell !== undefined && cell !== "") {
      rows.push({ lineno: index + 1, cell });
    }
  }

  return rows;
}

function workingDirectory(): string | Failure {
  try {
    return process.cwd();
  } catch (error) {
    return new Failure(`cannot read the working directory: ${errorMessage(error)}`);
  }
}

function gitRoot(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });

  if (result.status !== 0) {
    return undefined;
  }

  return result.stdout.replace(/\n$/, "");
}

function trackedFiles(root: string): string[] | Failure {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: Number.POSITIVE_INFINITY,
  });

  if (result.error !== undefined) {
    return new Failure(`git ls-files failed in ${root}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    return new Failure(`git ls-files failed in ${root}: ${result.stderr.trim()}`);
  }

  return result.stdout
    .split("\0")
    .filter((path) => path !== "")
    .map((path) => join(root, path));
}

function listEntries(directory: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function filesNear(directory: string): string[] {
  const files: string[] = [];

  for (const entry of listEntries(directory)) {
    const path = join(directory, entry.name);

    if (entry.isFile()) {
      files.push(path);
    } else if (entry.isDirectory()) {
      for (const inner of listEntries(path)) {
        if (inner.isFile()) {
          files.push(join(path, inner.name));
        }
      }
    }
  }

  return files;
}

function indexByName(paths: readonly string[]): Map<string, string[]> {
  const filesByName = new Map<string, string[]>();

  for (const path of paths) {
    const name = basename(path);
    const files = filesByName.get(name);

    if (files === undefined) {
      filesByName.set(name, [path]);
    } else {
      files.push(path);
    }
  }

  return filesByName;
}

function buildSearch(logfile: string): Search | Failure {
  const cwd = workingDirectory();

  if (cwd instanceof Failure) {
    return cwd;
  }

  const logDir = resolve(cwd, dirname(logfile));
  const root = gitRoot(cwd);

  if (root === undefined) {
    return { bases: [logDir, cwd], filesByName: indexByName(filesNear(logDir)) };
  }

  const tracked = trackedFiles(root);

  if (tracked instanceof Failure) {
    return tracked;
  }

  return {
    bases: [logDir, root, cwd],
    filesByName: indexByName([...filesNear(logDir), ...tracked]),
  };
}

function stripToken(raw: string): string {
  const markdownLink = /\]\(([^)]+)\)/.exec(raw);
  const token = markdownLink?.[1] ?? raw;

  return token.replace(/^[`("'[<]+/, "").replace(/[\]`.:!?)"'>]+$/, "");
}

function parseLineSuffix(token: string): { path: string; lines: LineRange } | undefined {
  for (const pattern of lineSuffixes) {
    const match = pattern.exec(token);

    if (match?.[1] !== undefined && match[2] !== undefined) {
      return {
        path: match[1],
        lines: { start: Number(match[2]), end: Number(match[3] ?? match[2]) },
      };
    }
  }

  return undefined;
}

function parsePointer(raw: string): Pointer | undefined {
  const token = stripToken(raw);

  if (token === "" || token.includes("://") || /^[\w.-]+\/[\w.-]+#\d+$/.test(token)) {
    return undefined;
  }

  const suffix = parseLineSuffix(token);
  const path = suffix?.path ?? token.split("#")[0] ?? "";

  if (path === "" || isRevisionOrLabel(path)) {
    return undefined;
  }

  return { token, path, lines: suffix?.lines };
}

function isRevisionOrLabel(path: string): boolean {
  return path.includes(":");
}

function isGlob(path: string): boolean {
  return /[*?[]/.test(path);
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function existingPaths({ directory, path }: Location): string[] {
  const file = join(directory, path);

  if (existsSync(file)) {
    return [file];
  }

  if (!isGlob(path)) {
    return [];
  }

  // A recursive ** from a home or root directory would walk the whole tree.
  const pattern = path.replace(/\*{2,}/g, "*");

  return globSync(pattern, { cwd: directory })
    .map((match) => join(directory, match))
    .sort();
}

function searchLocations(path: string, directories: ReadonlySet<string>): Location[] {
  if (path.startsWith("~/")) {
    return [{ directory: homedir(), path: path.slice(2) }];
  }

  if (path.startsWith("/")) {
    return [{ directory: "/", path: path.slice(1) }];
  }

  return [...directories].map((directory) => ({ directory, path }));
}

function findCandidates(path: string, directories: ReadonlySet<string>, search: Search): string[] {
  const candidates = new Set<string>();
  const add = (files: readonly string[]) => {
    for (const file of files) {
      candidates.add(file);
    }
  };

  for (const location of searchLocations(path, directories)) {
    add(existingPaths(location));
  }

  if (!path.includes("/")) {
    add(search.filesByName.get(path) ?? []);
  }

  return [...candidates];
}

function hasFileExtension(path: string): boolean {
  const name = basename(path);
  const dot = name.lastIndexOf(".");

  return dot > 0 && fileExtensions.has(name.slice(dot + 1));
}

function isPointer(path: string, directories: ReadonlySet<string>, candidates: readonly string[]): boolean {
  const segments = path.split("/");

  if (path.startsWith("/")) {
    return existsSync(`/${segments[1] ?? ""}`);
  }

  if (/^(~|\.|\.\.)\//.test(path) || path.endsWith("/") || hasFileExtension(path)) {
    return true;
  }

  if (!path.includes("/")) {
    return candidates.some(isRegularFile);
  }

  const top = segments[0] ?? "";

  return [...directories].some((directory) => existsSync(join(directory, top)));
}

function nearbyDirectories(candidate: string): string[] {
  const directory = isDirectory(candidate) ? candidate : dirname(candidate);

  return [directory, dirname(directory)];
}

function countLines(file: string): number | undefined {
  const chunk = Buffer.alloc(64 * 1024);
  let descriptor: number | undefined;

  try {
    descriptor = openSync(file, "r");
    let count = 0;
    let last = 0x0a;
    let read = readSync(descriptor, chunk);

    while (read > 0) {
      for (let index = 0; index < read; index++) {
        if (chunk[index] === 0x0a) {
          count++;
        }
      }

      last = chunk[read - 1] ?? last;
      read = readSync(descriptor, chunk);
    }

    return last === 0x0a ? count : count + 1;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function rangeFailure(file: string, lines: LineRange): string | undefined {
  if (!isRegularFile(file)) {
    return "not a regular file";
  }

  const count = countLines(file);

  if (count === undefined) {
    return "unreadable";
  }

  if (lines.start >= 1 && lines.end <= count) {
    return undefined;
  }

  return `line out of range, file has ${count} lines`;
}

function lineFailure(lines: LineRange, candidates: readonly string[]): string | undefined {
  if (lines.start > lines.end) {
    return "range is reversed";
  }

  let firstFailure: string | undefined;

  for (const candidate of candidates) {
    const failure = rangeFailure(candidate, lines);

    if (failure === undefined) {
      return undefined;
    }

    firstFailure ??= failure;
  }

  return firstFailure;
}

function checkRow(row: Row, search: Search): Finding[] {
  const findings: Finding[] = [];
  const directories = new Set(search.bases);

  for (const raw of row.cell.split(/[ \t\n\v\f\r,;]+/)) {
    const pointer = parsePointer(raw);

    if (pointer === undefined) {
      continue;
    }

    const candidates = findCandidates(pointer.path, directories, search);

    if (!isPointer(pointer.path, directories, candidates)) {
      continue;
    }

    const [first] = candidates;

    if (first === undefined) {
      findings.push({ lineno: row.lineno, token: pointer.token, reason: "no such file" });
      continue;
    }

    for (const directory of nearbyDirectories(first)) {
      directories.add(directory);
    }

    if (pointer.lines === undefined) {
      continue;
    }

    const failure = lineFailure(pointer.lines, candidates);

    if (failure !== undefined) {
      findings.push({ lineno: row.lineno, token: pointer.token, reason: failure });
    }
  }

  return findings;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(argv: readonly string[]): number {
  const options = parseArguments(argv);

  if (options instanceof Failure) {
    return fail(options);
  }

  const log = readLog(options.logfile);

  if (log instanceof Failure) {
    return fail(log);
  }

  const rows = parseRows(options.logfile, log, options.firstLine);

  if (rows instanceof Failure) {
    return fail(rows);
  }

  const search = buildSearch(options.logfile);

  if (search instanceof Failure) {
    return fail(search);
  }

  const findings = rows.flatMap((row) => checkRow(row, search));
  const report = findings.map(
    ({ lineno, token, reason }) => `${options.logfile}:${lineno}: ${token} (${reason})\n`,
  );

  process.stdout.write(report.join(""));

  return findings.length > 0 ? 1 : 0;
}

function fail(failure: Failure): number {
  process.stderr.write(`check-evidence.ts: ${failure.message}\n`);

  return 64;
}

function reportWriteFailure(error: Error): void {
  if ("code" in error && error.code === "EPIPE") {
    return;
  }

  process.exitCode = fail(new Failure(`cannot write the report: ${error.message}`));
}

process.stdout.on("error", reportWriteFailure);

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.exitCode = fail(new Failure(errorMessage(error)));
}
