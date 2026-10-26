#!/usr/bin/env node
// Publish a PR title and body with gh, only after check-body.ts passes them, then read the
// PR back and compare it with what was sent.
// Exit: 0 published and read back equal, 1 check-body found problems, 64 bad argument or
// unreadable file, 2 a gh call failed or check-body could not run, 3 the readback differs.

// Without import statements the file runs as CommonJS or as an ES module, like check-body.ts.
const { spawnSync } = process.getBuiltinModule("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = process.getBuiltinModule("node:fs");
const { tmpdir } = process.getBuiltinModule("node:os");
const { dirname, join } = process.getBuiltinModule("node:path");

type Target =
  | { kind: "create"; base: string | undefined; head: string | undefined }
  | { kind: "edit"; number: string };

type Arguments = {
  target: Target;
  bodyFile: string;
  title: string;
  repo: string | undefined;
  template: string | undefined;
};

type PullRequest = { title: string; body: string };

class Failure {
  readonly message: string;

  constructor(message: string) {
    this.message = message;
  }
}

const usage =
  "expected create <body-file> --title <title> [--base <branch>] [--head <branch>] [--repo <owner/repo>] [--template <file>], " +
  "or edit <number> <body-file> --title <title> [--repo <owner/repo>] [--template <file>]";

const optionsFor = {
  create: ["--title", "--base", "--head", "--repo", "--template"],
  edit: ["--title", "--repo", "--template"],
} as const;

function parseArguments(argv: readonly string[]): Arguments | Failure {
  const [verb, ...rest] = argv;

  if (verb !== "create" && verb !== "edit") return new Failure(usage);

  const number = verb === "edit" ? rest[0] : undefined;
  const bodyFile = verb === "edit" ? rest[1] : rest[0];
  const words = rest.slice(verb === "edit" ? 2 : 1);

  if (bodyFile === undefined || (verb === "edit" && !/^[1-9][0-9]*$/.test(number ?? ""))) {
    return new Failure(usage);
  }

  const allowed: readonly string[] = optionsFor[verb];
  const options = new Map<string, string>();

  for (let index = 0; index < words.length; index += 2) {
    const [name, value] = [words[index], words[index + 1]];

    if (!allowed.includes(name) || value === undefined || options.has(name)) {
      return new Failure(usage);
    }

    options.set(name, value);
  }

  const title = options.get("--title");

  if (title === undefined) return new Failure(usage);

  const target: Target =
    verb === "edit"
      ? { kind: "edit", number: number ?? "" }
      : { kind: "create", base: options.get("--base"), head: options.get("--head") };

  return {
    target,
    bodyFile,
    title,
    repo: options.get("--repo"),
    template: options.get("--template"),
  };
}

// An option and its value, or nothing when the value is absent.
function flag(name: string, value: string | undefined): string[] {
  return value === undefined ? [] : [name, value];
}

function checkBody(args: Arguments): number {
  const script = join(dirname(process.argv[1] ?? "."), "check-body.ts");
  const result = spawnSync(
    process.execPath,
    [script, "pr", args.bodyFile, "--title", args.title, ...flag("--template", args.template)],
    { stdio: "inherit" },
  );

  if (result.status === 0 || result.status === 1 || result.status === 64) return result.status;

  console.error(
    `publish-pr: check-body could not run: ${result.error?.message ?? `exit ${result.status ?? result.signal}`}`,
  );
  return 2;
}

function gh(args: readonly string[]): string | Failure {
  const result = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

  if (result.error !== undefined) return new Failure(`cannot run gh: ${result.error.message}`);

  if (result.status !== 0) {
    return new Failure(`gh ${args.slice(0, 2).join(" ")} exited ${result.status ?? result.signal}`);
  }

  return result.stdout;
}

function viewPullRequest(pr: string, repo: string | undefined): PullRequest | Failure {
  const output = gh(["pr", "view", pr, "--json", "title,body", ...flag("--repo", repo)]);

  if (output instanceof Failure) return output;

  let value: unknown;

  try {
    value = JSON.parse(output);
  } catch {
    return new Failure(`gh pr view printed no JSON: ${output.slice(0, 200)}`);
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("body" in value) ||
    typeof value.body !== "string"
  ) {
    return new Failure("gh pr view printed no title and body");
  }

  return { title: value.title, body: value.body };
}

type Block = { heading: string | undefined; text: string };

// Splits a body into the text before the first ## heading and one block per ## section, each
// without its trailing blank lines. The heading rule and fenced() are twins of parseBody and
// fenced in check-body.ts, copied because neither file may import the other.
function blocks(text: string): Block[] {
  const lines = text.split("\n");
  const inFence = fenced(lines);
  const result: { heading: string | undefined; lines: string[] }[] = [
    { heading: undefined, lines: [] },
  ];

  for (const [index, line] of lines.entries()) {
    const heading = inFence[index] ? null : line.match(/^## +(.+?)\s*#*\s*$/);

    if (heading) {
      result.push({ heading: heading[1], lines: [line] });
    } else {
      result[result.length - 1].lines.push(line);
    }
  }

  return result.map((block) => ({
    heading: block.heading,
    text: block.lines.join("\n").trimEnd(),
  }));
}

function fenced(lines: readonly string[]): boolean[] {
  let open: string | undefined;

  return lines.map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);

    if (open === undefined) {
      open = marker?.[1];
      return marker !== null;
    }

    if (
      marker !== null &&
      marker[1][0] === open[0] &&
      marker[1].length >= open.length &&
      marker[2].trim() === ""
    ) {
      open = undefined;
    }

    return true;
  });
}

function normalize(heading: string) {
  return heading.trim().toLowerCase();
}

// `gh pr edit --body-file` replaces the whole body, which drops a section a bot appended, such
// as a plan or a deploy preview. Each ## section the live body has and the draft lacks is kept
// after the nearest section before it that the draft has, or first when none precedes it.
function keepLiveSections(draft: string, live: string): { body: string; kept: string[] } {
  const ours = blocks(draft);
  const known = new Set(
    ours.flatMap((block) => (block.heading === undefined ? [] : [normalize(block.heading)])),
  );
  const after = new Map<string | undefined, { heading: string; text: string }[]>();
  let anchor: string | undefined;

  for (const { heading, text } of blocks(live.replaceAll("\r\n", "\n"))) {
    if (heading === undefined) continue;

    const key = normalize(heading);

    if (known.has(key)) {
      anchor = key;
    } else {
      after.set(anchor, [...(after.get(anchor) ?? []), { heading, text }]);
    }
  }

  if (after.size === 0) return { body: draft, kept: [] };

  const kept: string[] = [];

  // blocks() starts with the preamble, whose key is undefined, so sections that no draft section
  // precedes land after it. Each key is taken once, so a heading the draft repeats adds nothing.
  const merged = ours.flatMap((block) => {
    const key = block.heading === undefined ? undefined : normalize(block.heading);
    const theirs = after.get(key) ?? [];
    after.delete(key);

    for (const section of theirs) kept.push(section.heading);

    return [block, ...theirs];
  });

  return {
    body: `${merged
      .map((block) => block.text)
      .filter((text) => text !== "")
      .join("\n\n")}\n`,
    kept,
  };
}

// The changed lines between the common head and the common tail of two texts.
function lineDiff(sent: string, readBack: string): string[] {
  const a = sent.split("\n");
  const b = readBack.split("\n");
  let head = 0;

  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;

  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  return [
    ...a.slice(head, a.length - tail).map((line, index) => `-${head + index + 1}: ${line}`),
    ...b.slice(head, b.length - tail).map((line, index) => `+${head + index + 1}: ${line}`),
  ];
}

// GitHub may store a body with \r\n line ends or another trailing newline. Neither is a change.
function comparable(body: string) {
  return body.replaceAll("\r\n", "\n").replace(/\n+$/, "");
}

function readbackFindings(title: string, body: string, pr: PullRequest): string[] {
  const findings: string[] = [];

  if (pr.title.trim() !== title.trim()) {
    findings.push(`title read back as ${JSON.stringify(pr.title)}, sent ${JSON.stringify(title)}`);
  }

  const [sent, readBack] = [comparable(body), comparable(pr.body)];

  if (sent !== readBack) {
    findings.push(
      "body read back differs from the body sent (- sent, + read back):",
      ...lineDiff(sent, readBack),
    );
  }

  return findings;
}

function publish(args: Arguments, draft: string): number {
  const { target } = args;
  let body = draft;

  if (target.kind === "edit") {
    const live = viewPullRequest(target.number, args.repo);

    if (live instanceof Failure) return ghFailed(live);

    const merged = keepLiveSections(draft, live.body);

    for (const heading of merged.kept)
      console.log(`publish-pr: kept "## ${heading}" from the live body`);

    body = merged.body;
  }

  const dir = mkdtempSync(join(tmpdir(), "publish-pr-"));

  try {
    const sentFile = join(dir, "body.md");
    writeFileSync(sentFile, body);

    const verb =
      target.kind === "edit"
        ? ["edit", target.number]
        : ["create", ...flag("--base", target.base), ...flag("--head", target.head)];

    const output = gh([
      "pr",
      ...verb,
      "--title",
      args.title,
      "--body-file",
      sentFile,
      ...flag("--repo", args.repo),
    ]);

    if (output instanceof Failure) return ghFailed(output);

    // gh prints the PR's URL. create needs it to find the PR; edit names it only in the log.
    const printedUrl = output.trim().split("\n").at(-1) ?? "";
    const pr = target.kind === "edit" ? target.number : printedUrl;

    if (pr === "") return ghFailed(new Failure("gh pr create printed no PR URL"));

    const readBack = viewPullRequest(pr, args.repo);

    if (readBack instanceof Failure) return ghFailed(readBack);

    const findings = readbackFindings(args.title, body, readBack);

    for (const finding of findings) console.error(`publish-pr: ${finding}`);

    if (findings.length > 0) return 3;

    console.log(`publish-pr: published ${printedUrl === "" ? `#${pr}` : printedUrl}`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ghFailed(failure: Failure): number {
  console.error(`publish-pr: ${failure.message}`);
  return 2;
}

function main(): number {
  const args = parseArguments(process.argv.slice(2));

  if (args instanceof Failure) {
    console.error(`publish-pr: ${args.message}`);
    return 64;
  }

  const checked = checkBody(args);

  if (checked !== 0) return checked;

  let draft: string;

  try {
    draft = readFileSync(args.bodyFile, "utf8");
  } catch (error) {
    console.error(
      `publish-pr: cannot read ${args.bodyFile}: ${error instanceof Error ? error.message : error}`,
    );
    return 64;
  }

  return publish(args, draft);
}

process.exitCode = main();
