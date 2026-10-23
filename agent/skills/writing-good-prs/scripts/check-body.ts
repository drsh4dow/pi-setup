#!/usr/bin/env node
// Print each problem in a PR or ticket body, one per line, as <body-file>:<line>: <problem>.
// Exit: 0 clean, 1 problems, 64 bad argument or unreadable file.

// Without import statements the file runs as CommonJS or as an ES module, so a
// copy of the skill under any package.json runs without a warning.
const { readFileSync } = process.getBuiltinModule("node:fs");

type Kind = "pr" | "ticket";

type SectionRule = { heading: string; required: boolean };

type Line = { number: number; text: string };

type Section = { heading: string; line: number; lines: Line[] };

type Body = { preamble: Line[]; sections: Section[]; lines: Line[] };

type Finding = { where: number | "title"; message: string };

type Arguments = {
  kind: Kind;
  bodyFile: string;
  title: string | undefined;
  template: string | undefined;
};

class Failure {
  readonly message: string;

  constructor(message: string) {
    this.message = message;
  }
}

const defaultShapes: Record<Kind, readonly SectionRule[]> = {
  pr: [
    { heading: "Why", required: true },
    { heading: "Shape", required: false },
    { heading: "Evidence", required: true },
    { heading: "Merge danger", required: true },
    { heading: "Scope", required: true },
    { heading: "Tradeoffs", required: false },
  ],
  ticket: [
    { heading: "Problem", required: true },
    { heading: "Done when", required: true },
    { heading: "Suggested approach", required: false },
    { heading: "Context", required: false },
  ],
};

const MAX_PR_LINES = 40;

const usage = "expected <pr|ticket> <body-file> [--title <title>] [--template <file>]";

function parseArguments(argv: readonly string[]): Arguments | Failure {
  const [kind, bodyFile, ...options] = argv;

  if ((kind !== "pr" && kind !== "ticket") || bodyFile === undefined) {
    return new Failure(usage);
  }

  let title: string | undefined;
  let template: string | undefined;

  for (let index = 0; index < options.length; index += 2) {
    const value = options[index + 1];

    if (value === undefined) return new Failure(usage);

    if (options[index] === "--title") {
      title = value;
    } else if (options[index] === "--template") {
      template = value;
    } else {
      return new Failure(usage);
    }
  }

  return { kind, bodyFile, title, template };
}

function readText(path: string): string | Failure {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    return new Failure(`cannot read ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

function parseBody(text: string): Body {
  const lines = text
    .replace(/^---\n[\s\S]*?\n---\n/, (frontmatter) =>
      "\n".repeat(frontmatter.split("\n").length - 1),
    )
    .split("\n")
    .map((line, index) => ({ number: index + 1, text: line.replace(/\r$/, "") }));
  const preamble: Line[] = [];
  const sections: Section[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line.text)) inFence = !inFence;

    const heading = inFence ? null : line.text.match(/^## +(.+?)\s*#*\s*$/);
    const current = sections.at(-1);

    if (heading) {
      sections.push({ heading: heading[1], line: line.number, lines: [] });
    } else if (current === undefined) {
      preamble.push(line);
    } else {
      current.lines.push(line);
    }
  }

  return { preamble, sections, lines };
}

function templateShape(kind: Kind, template: string): SectionRule[] | Failure {
  const optional = new Set(
    defaultShapes[kind].filter((rule) => !rule.required).map((rule) => normalize(rule.heading)),
  );
  const headings = parseBody(template).sections.map((section) => section.heading);

  if (headings.length === 0) return new Failure("the template has no ## headings");

  return headings.map((heading) => ({ heading, required: !optional.has(normalize(heading)) }));
}

function normalize(heading: string) {
  return heading.trim().toLowerCase();
}

function headingFindings(body: Body, shape: readonly SectionRule[]): Finding[] {
  const findings: Finding[] = [];
  const order = shape.map((rule) => normalize(rule.heading));
  const expected = shape.map((rule) => `## ${rule.heading}`).join(", ");
  let previous = -1;

  for (const section of body.sections) {
    const position = order.indexOf(normalize(section.heading));

    if (position === -1) {
      findings.push({
        where: section.line,
        message: `unexpected heading "## ${section.heading}", use these in order: ${expected}`,
      });
    } else if (position <= previous) {
      findings.push({
        where: section.line,
        message: `"## ${section.heading}" is out of order or repeated, use these in order: ${expected}`,
      });
    } else {
      previous = position;
    }
  }

  const present = new Set(body.sections.map((section) => normalize(section.heading)));

  for (const rule of shape) {
    if (rule.required && !present.has(normalize(rule.heading))) {
      findings.push({ where: 1, message: `missing "## ${rule.heading}"` });
    }
  }

  return findings;
}

function sectionNamed(body: Body, names: readonly string[]) {
  return body.sections.find((section) => names.includes(normalize(section.heading)));
}

function proseLines(lines: readonly Line[]) {
  const prose: Line[] = [];
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line.text)) {
      inFence = !inFence;
    } else if (!inFence) {
      prose.push(line);
    }
  }

  return prose;
}

function contentFindings(kind: Kind, body: Body): Finding[] {
  const findings: Finding[] = [];
  const nonBlank = body.lines.filter((line) => line.text.trim() !== "");

  for (const line of body.preamble) {
    const text = line.text.trim();

    // The tracker records put a "Blocked by:" line first where the tracker has no native edge.
    if (text !== "" && !text.startsWith("<!--") && !/^Blocked by:/.test(text)) {
      findings.push({
        where: line.number,
        message: "text before the first section, start at the first ## heading",
      });
      break;
    }
  }

  for (const line of proseLines(body.lines)) {
    if (/[\u2013\u2014]/.test(line.text)) {
      findings.push({ where: line.number, message: "long dash, use a period or a comma" });
    }

    if (line.text.includes("<!--")) {
      findings.push({
        where: line.number,
        message: "template comment left in, replace or delete it",
      });
    }
  }

  const evidence = sectionNamed(body, ["evidence", "verification"]);
  const artifact = /https?:\/\/|`[^`]+`|^\s*(```|~~~)|^\s*\|/;

  if (evidence !== undefined && !evidence.lines.some((line) => artifact.test(line.text))) {
    findings.push({
      where: evidence.line,
      message: `"## ${evidence.heading}" names no artifact, add the test, command, output, or media link that shows before and after`,
    });
  }

  const doneWhen = sectionNamed(body, ["done when", "acceptance criteria"]);

  if (
    doneWhen !== undefined &&
    !doneWhen.lines.some((line) => /^\s*- \[[ xX]\] \S/.test(line.text))
  ) {
    findings.push({
      where: doneWhen.line,
      message: `"## ${doneWhen.heading}" has no "- [ ]" check`,
    });
  }

  if (kind === "ticket") return findings;

  const mergeDanger = sectionNamed(body, ["merge danger"]);

  if (mergeDanger !== undefined) {
    const text = mergeDanger.lines.map((line) => line.text).join("\n");

    if (!/\b(one|two)-way door\b/i.test(text)) {
      findings.push({
        where: mergeDanger.line,
        message: '"## Merge danger" does not say "one-way door" or "two-way door"',
      });
    }

    if (!/\bblast radius\b/i.test(text)) {
      findings.push({
        where: mergeDanger.line,
        message: '"## Merge danger" does not name the blast radius',
      });
    }
  }

  if (nonBlank.length > MAX_PR_LINES) {
    findings.push({
      where: nonBlank[MAX_PR_LINES].number,
      message: `${nonBlank.length} non-blank lines, keep the body to ${MAX_PR_LINES} and link the rest`,
    });
  }

  return findings;
}

function titleFindings(kind: Kind, title: string): Finding[] {
  if (/[.\u2013\u2014]$/.test(title.trim())) {
    return [{ where: "title", message: "title ends with punctuation" }];
  }

  if (
    kind === "pr" &&
    !/^(feat|fix|docs|refactor|test|chore|perf|build|ci|revert)(\([^)]+\))?!?: \S/.test(title)
  ) {
    return [
      { where: "title", message: 'title is not Conventional Commits "type(scope): subject"' },
    ];
  }

  if (kind === "ticket" && !/^[^:\s][^:]*: \S/.test(title)) {
    return [{ where: "title", message: 'title is not "area: symptom"' }];
  }

  return [];
}

function order(finding: Finding) {
  return finding.where === "title" ? 0 : finding.where;
}

function main(): number {
  const args = parseArguments(process.argv.slice(2));

  if (args instanceof Failure) {
    console.error(`check-body: ${args.message}`);
    return 64;
  }

  const text = readText(args.bodyFile);

  if (text instanceof Failure) {
    console.error(`check-body: ${text.message}`);
    return 64;
  }

  let shape: readonly SectionRule[] = defaultShapes[args.kind];

  if (args.template !== undefined) {
    const template = readText(args.template);
    const parsed = template instanceof Failure ? template : templateShape(args.kind, template);

    if (parsed instanceof Failure) {
      console.error(`check-body: ${args.template}: ${parsed.message}`);
      return 64;
    }

    shape = parsed;
  }

  const body = parseBody(text);
  const findings = [
    ...(args.title === undefined ? [] : titleFindings(args.kind, args.title)),
    ...headingFindings(body, shape),
    ...contentFindings(args.kind, body),
  ].sort((a, b) => order(a) - order(b));

  for (const finding of findings) {
    console.log(`${args.bodyFile}:${finding.where}: ${finding.message}`);
  }

  return findings.length === 0 ? 0 : 1;
}

process.exitCode = main();
