#!/usr/bin/env node

// Flags the cheap roads to green in everything not yet pushed: committed, staged, unstaged, and
// untracked changes against the upstream branch. A regex-level guard catches the moves agents
// actually make (a skipped or deleted test, a silenced checker, a swallowed error, a loosened
// threshold, a removed check), not a determined human hiding a change. When it cannot tell
// whether a change tightens or loosens, it reports it.
//
// Exit codes: 0 clean, 1 a finding or an expired exception, 2 could not run.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { Schema } from "effect";

const EXCEPTIONS_FILE = "scripts/verify-gates.exceptions.json";

const Rule = Schema.Literals([
  "test-skipped",
  "test-deleted",
  "assertions-removed",
  "checker-silenced",
  "empty-catch",
  "threshold-loosened",
  "threshold-changed",
  "check-removed",
]);

type Rule = typeof Rule.Type;

const GateException = Schema.Struct({
  path: Schema.NonEmptyString,
  rule: Rule,
  reason: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
  until: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { message: "Expected a YYYY-MM-DD date" }),
    ),
  ),
});

type GateException = typeof GateException.Type;

const decodeExceptions = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(GateException)),
);

interface Line {
  readonly number: number;
  readonly text: string;
}

interface Hunk {
  readonly removed: Line[];
  readonly added: Line[];
}

interface FileChange {
  readonly path: string;
  readonly deleted: boolean;
  readonly hunks: readonly Hunk[];
}

interface Finding {
  readonly rule: Rule;
  readonly path: string;
  readonly line: number | undefined;
  readonly detail: string;
}

class CouldNotRun extends Error {}

const TEST_PATH =
  /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/;

const CODE_PATH = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|sh|bash|java|kt|swift|c|cc|cpp|h|hpp|cs|php)$/;

const CONFIG_PATH = /\.(?:json|jsonc|ya?ml|toml)$/;

const CHECK_CONFIG_PATH =
  /(?:^|\/)(?:package\.json|vite\.config\.[cm]?[jt]s|lefthook\.ya?ml|\.pre-commit-config\.yaml)$|(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

const SKIPPED_TEST =
  /\b(?:describe|it|test|suite|context)\.(?:skip|only|todo)\b|\bx(?:it|describe|test)\s*\(/;

const SKIP_OPTION =
  /\{\s*(?:skip|todo)\s*:\s*(?:true|["'`])|\bt\.(?:skip|todo)\s*\(|@pytest\.mark\.skip/;

const SILENCED_CHECKER =
  /@ts-(?:ignore|expect-error|nocheck)\b|\b(?:eslint|oxlint)-disable\b|\bbiome-ignore\b|#\s*type:\s*ignore\b|#\s*noqa\b/;

const EMPTY_CATCH =
  /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}|\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)|\bexcept\b[^:\n]*:\s*pass\b/g;

const ASSERTION =
  /\bassert(?:\.\w+)?\s*\(|\bexpect\s*\(|\bt\.(?:assert|equal|deepEqual|ok|throws|is)\b/;

const CHECK_WORD = /\b(?:verify|test|tests|lint|check|typecheck)\b/;

const SETTING =
  /["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*(?:(-?\d+(?:\.\d+)?)\b|["'](error|warn|warning|off|deny|allow)["'])/g;

const HIGHER_IS_LOOSER = new Set([
  "max",
  "maximum",
  "budget",
  "limit",
  "timeout",
  "tolerance",
  "retries",
  "retry",
  "ceiling",
  "warnings",
  "allowed",
]);

const LOWER_IS_LOOSER = new Set(["min", "minimum", "coverage", "floor"]);

const DIRECTION_UNKNOWN = new Set(["threshold", "thresholds", "severity", "level", "score"]);

const SEVERITY_RANK = new Map([
  ["deny", 2],
  ["error", 2],
  ["warn", 1],
  ["warning", 1],
  ["allow", 0],
  ["off", 0],
]);

function git(root: string, args: readonly string[]) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function diffBase(root: string) {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", "@{upstream}"]);
  } catch {
    return { base: "HEAD", scope: "uncommitted changes only, because the branch has no upstream" };
  }

  const base = git(root, ["merge-base", "HEAD", "@{upstream}"]).trim();

  return { base, scope: `changes since ${base.slice(0, 7)}, the merge base with upstream` };
}

function stripPrefix(raw: string) {
  const path = raw.replace(/\t$/, "").replace(/^"|"$/g, "");

  if (path === "/dev/null") return undefined;

  return path.replace(/^[ab]\//, "");
}

function parsePatch(patch: string): FileChange[] {
  const files: FileChange[] = [];
  let path: string | undefined;
  let deleted = false;
  let hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const finish = () => {
    if (path !== undefined) files.push({ path, deleted, hunks });
  };

  for (const line of patch.split("\n")) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("-")) {
        hunk.removed.push({ number: oldLine, text: line.slice(1) });
        oldLine += 1;
        oldLeft -= 1;
      } else if (line.startsWith("+")) {
        hunk.added.push({ number: newLine, text: line.slice(1) });
        newLine += 1;
        newLeft -= 1;
      }

      continue;
    }

    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

    if (header) {
      oldLine = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLine = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      hunk = { removed: [], added: [] };
      hunks.push(hunk);
    } else if (line.startsWith("diff --git ")) {
      finish();
      path = line.match(/ b\/(.+)$/)?.[1];
      deleted = false;
      hunks = [];
      hunk = undefined;
    } else if (line.startsWith("deleted file mode")) {
      deleted = true;
    } else if (line.startsWith("--- ")) {
      path = stripPrefix(line.slice(4)) ?? path;
    } else if (line.startsWith("+++ ")) {
      path = stripPrefix(line.slice(4)) ?? path;
    }
  }

  finish();

  return files;
}

function untrackedFiles(root: string): FileChange[] {
  return git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((path) => path !== "" && existsSync(resolve(root, path)))
    .flatMap((path) => {
      const content = readFileSync(resolve(root, path), "utf8");

      if (content.includes("\0")) return [];

      const added = content.split("\n").map((text, index) => ({ number: index + 1, text }));

      return [{ path, deleted: false, hunks: [{ removed: [], added }] }];
    });
}

function contentFindings({ path, hunks }: FileChange): Finding[] {
  if (!CODE_PATH.test(path)) return [];

  const findings: Finding[] = [];
  const isTest = TEST_PATH.test(path);

  for (const { added } of hunks) {
    for (const { number, text } of added) {
      if (SKIPPED_TEST.test(text) || (isTest && SKIP_OPTION.test(text))) {
        findings.push({ rule: "test-skipped", path, line: number, detail: text.trim() });
      }

      if (SILENCED_CHECKER.test(text)) {
        findings.push({ rule: "checker-silenced", path, line: number, detail: text.trim() });
      }
    }

    // A catch can span lines, so match over the hunk's added text and map back to a line.
    const text = added.map((line) => line.text).join("\n");

    for (const match of text.matchAll(EMPTY_CATCH)) {
      const lineIndex = text.slice(0, match.index).split("\n").length - 1;

      findings.push({
        rule: "empty-catch",
        path,
        line: added[lineIndex].number,
        detail: match[0].replace(/\s+/g, " "),
      });
    }
  }

  return findings;
}

function assertionCount(lines: readonly Line[]) {
  return lines.filter(({ text }) => ASSERTION.test(text)).length;
}

function assertionFindings({ path, deleted, hunks }: FileChange): Finding[] {
  if (deleted || !TEST_PATH.test(path) || !CODE_PATH.test(path)) return [];

  const removed = hunks.reduce((total, hunk) => total + assertionCount(hunk.removed), 0);
  const added = hunks.reduce((total, hunk) => total + assertionCount(hunk.added), 0);

  if (removed <= added) return [];

  return [
    {
      rule: "assertions-removed",
      path,
      line: undefined,
      detail: `${removed} assertion lines removed, ${added} added, in a test file that stays`,
    },
  ];
}

function settings(lines: readonly Line[]) {
  const values = new Map<string, { value: string; line: number }>();

  for (const { number, text } of lines) {
    for (const [, key, numeric, severity] of text.matchAll(SETTING)) {
      values.set(key, { value: numeric ?? severity, line: number });
    }
  }

  return values;
}

function keyWords(key: string) {
  return key
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function thresholdRule(key: string, before: string, after: string): Rule | undefined {
  const severityBefore = SEVERITY_RANK.get(before);
  const severityAfter = SEVERITY_RANK.get(after);

  if (severityBefore !== undefined && severityAfter !== undefined) {
    if (severityAfter < severityBefore) return "threshold-loosened";

    return undefined;
  }

  const words = keyWords(key);
  const higherLoosens = words.some((word) => HIGHER_IS_LOOSER.has(word));
  const lowerLoosens = words.some((word) => LOWER_IS_LOOSER.has(word));

  if (higherLoosens && !lowerLoosens) {
    if (Number(after) > Number(before)) return "threshold-loosened";

    return undefined;
  }

  if (lowerLoosens && !higherLoosens) {
    if (Number(after) < Number(before)) return "threshold-loosened";

    return undefined;
  }

  if (higherLoosens || lowerLoosens || words.some((word) => DIRECTION_UNKNOWN.has(word))) {
    return "threshold-changed";
  }

  return undefined;
}

function thresholdFindings({ path, hunks }: FileChange): Finding[] {
  if (!CODE_PATH.test(path) && !CONFIG_PATH.test(path)) return [];

  const before = settings(hunks.flatMap((hunk) => hunk.removed));
  const after = settings(hunks.flatMap((hunk) => hunk.added));
  const findings: Finding[] = [];

  for (const [key, next] of after) {
    const previous = before.get(key);

    if (previous === undefined || previous.value === next.value) continue;

    const rule = thresholdRule(key, previous.value, next.value);

    if (rule === undefined) continue;

    findings.push({
      rule,
      path,
      line: next.line,
      detail: `${key}: ${previous.value} -> ${next.value}`,
    });
  }

  return findings;
}

function withoutTrailingComma(text: string) {
  return text.trim().replace(/,$/, "");
}

function checkFindings({ path, hunks }: FileChange): Finding[] {
  if (!CHECK_CONFIG_PATH.test(path)) return [];

  const added = new Set(
    hunks.flatMap((hunk) => hunk.added.map(({ text }) => withoutTrailingComma(text))),
  );

  return hunks.flatMap((hunk) =>
    hunk.removed
      .filter(({ text }) => CHECK_WORD.test(text) && !added.has(withoutTrailingComma(text)))
      .map(({ number, text }) => ({
        rule: "check-removed" as const,
        path,
        line: number,
        detail: `removed or changed: ${text.trim()}`,
      })),
  );
}

function findingsOf(change: FileChange): Finding[] {
  if (change.deleted) {
    if (!TEST_PATH.test(change.path)) return [];

    return [
      { rule: "test-deleted", path: change.path, line: undefined, detail: "test file deleted" },
    ];
  }

  return [
    ...contentFindings(change),
    ...assertionFindings(change),
    ...thresholdFindings(change),
    ...checkFindings(change),
  ];
}

function parseExceptions(root: string): readonly GateException[] {
  const file = resolve(root, EXCEPTIONS_FILE);

  if (!existsSync(file)) return [];

  try {
    return decodeExceptions(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CouldNotRun(`${EXCEPTIONS_FILE}: ${String(error)}`, { cause: error });
  }
}

function location({ path, line }: Finding) {
  if (line === undefined) return path;

  return `${path}:${line}`;
}

function main() {
  let root: string;

  try {
    root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  } catch (error) {
    throw new CouldNotRun("not inside a git repository", { cause: error });
  }

  const exceptions = parseExceptions(root);
  const { base, scope } = diffBase(root);
  const patch = git(root, ["diff", "--no-color", "--no-ext-diff", "-U0", "-M", base, "--"]);
  const changes = [...parsePatch(patch), ...untrackedFiles(root)];
  const findings = changes.flatMap(findingsOf);
  const today = new Date().toISOString().slice(0, 10);

  const covering = (finding: Finding) =>
    exceptions.find(({ path, rule }) => rule === finding.rule && matchesGlob(finding.path, path));

  const open = findings.filter((finding) => covering(finding) === undefined);
  const excepted = findings.filter((finding) => covering(finding) !== undefined);

  const expired = exceptions.filter(
    (exception) =>
      exception.until < today && excepted.some((finding) => covering(finding) === exception),
  );

  for (const finding of open) {
    console.error(`${location(finding)}: ${finding.rule}: ${finding.detail}`);
  }

  for (const exception of expired) {
    console.error(
      `${EXCEPTIONS_FILE}: the ${exception.rule} exception for ${exception.path} (owner ${exception.owner}) expired on ${exception.until}`,
    );
  }

  if (open.length === 0 && expired.length === 0) {
    console.log(
      `Gates verified (${scope}; ${changes.length} files, ${excepted.length} findings covered by exceptions).`,
    );

    return;
  }

  console.error(
    [
      `Checked ${scope}.`,
      "Fix the cause instead of weakening the gate. When loosening is the right call, add an",
      `entry to ${EXCEPTIONS_FILE} with path (a glob), rule, reason, owner, and until`,
      "(YYYY-MM-DD), and state it and the reason in your report.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(
    `verify-gates could not run: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 2;
}
