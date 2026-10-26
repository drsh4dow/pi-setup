#!/usr/bin/env node
// Print each problem in a PR or ticket body, one per line, as <body-file>:<line>: <problem>.
// A line that starts with "warning:" is a judgment call and leaves the exit code alone.
// Exit: 0 clean or warnings only, 1 problems, 64 bad argument or unreadable file.

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
    { heading: "Risk", required: true },
  ],
  ticket: [
    { heading: "Problem", required: true },
    { heading: "Done when", required: true },
    { heading: "Suggested approach", required: false },
    { heading: "Context", required: false },
  ],
};

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
  const inFence = fenced(lines);

  for (const [index, line] of lines.entries()) {
    const heading = inFence[index] ? null : line.text.match(/^## +(.+?)\s*#*\s*$/);
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

// Marks each line that opens, sits inside, or closes a fenced block. A fence closes only on
// the same character repeated at least as often, so a pasted body that holds ``` blocks
// inside a ```` block stays one block.
function fenced(lines: readonly Line[]): boolean[] {
  let open: string | undefined;

  return lines.map((line) => {
    const marker = line.text.match(/^\s*(`{3,}|~{3,})(.*)$/);

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

function proseLines(lines: readonly Line[]) {
  const inFence = fenced(lines);

  return lines.filter((_, index) => !inFence[index]);
}

function contentFindings(kind: Kind, body: Body): Finding[] {
  const findings: Finding[] = [];

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
  // A witness is something the reviewer sees: pasted output, a table, media, or a link.
  // Inline code alone names a command without showing what it printed.
  const witness = /https?:\/\/|!\[|<img|<video|<details|^\s*(```|~~~)|^\s*\|/;

  if (evidence !== undefined && !evidence.lines.some((line) => witness.test(line.text))) {
    findings.push({
      where: evidence.line,
      message: `"## ${evidence.heading}" shows no witness, paste the output, or add the table, media, or CI link that shows before and after`,
    });
  }

  if (
    kind === "pr" &&
    evidence !== undefined &&
    !proseLines(evidence.lines).some((line) => /^\s*\*\*Not checked:\*\*/.test(line.text))
  ) {
    findings.push({
      where: evidence.line,
      message: `"## ${evidence.heading}" has no "**Not checked:**" line, list what has no witness or write nothing`,
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

  const why = sectionNamed(body, ["why"]);

  if (why !== undefined) {
    const words = proseLines(why.lines)
      .filter((line) => !ticketLine.test(line.text))
      .flatMap((line) => line.text.split(/\s+/).filter(Boolean)).length;

    if (words > whyWordCap) {
      findings.push({
        where: why.line,
        message: `"## ${why.heading}" has ${words} words of prose, cut it to ${whyWordCap} or fewer`,
      });
    }
  }

  const risk = sectionNamed(body, ["risk"]);

  if (risk !== undefined) {
    const labels = new Map(
      risk.lines.flatMap((line) => {
        const label = line.text.match(/^\s*- \*\*(Blast radius|Door|Merge condition)\.\*\*(.*)$/i);
        return label ? [[label[1].toLowerCase(), label[2].trim()] as const] : [];
      }),
    );

    for (const label of ["Blast radius", "Door", "Merge condition"]) {
      const fact = labels.get(label.toLowerCase());

      if (fact === undefined) {
        findings.push({
          where: risk.line,
          message: `"## Risk" has no "- **${label}.**" line`,
        });
      } else if (fact === "") {
        findings.push({
          where: risk.line,
          message: `"## Risk" has an empty "- **${label}.**" line, give the fact`,
        });
      }
    }

    const door = labels.get("door");

    if (door !== undefined && !/\b(one|two)-way\b/i.test(door)) {
      findings.push({
        where: risk.line,
        message: '"## Risk" Door line does not say one-way or two-way',
      });
    }
  }

  return findings;
}

// The "Closes #N", "Part of #N", and "Depends on #N" lines that end a Why.
const ticketLine = /^\s*(Closes|Fixes|Resolves|Part of|Depends on|Refs:?)\s/i;

// Two short paragraphs. The longest of three hand-written multi-ticket Whys ran 166 words.
const whyWordCap = 180;

// A PR title becomes a commit subject, and writing-good-commits keeps a header within 72.
const prTitleCap = 72;

// Words from a multi-PR run that only its orchestrator understands.
const productionHistory =
  /\b(intermediate PRs?|integration (branch|head|tip)|final PRs?|chunk branch)\b/i;

function historyWarnings(body: Body): Finding[] {
  return proseLines(body.lines).flatMap((line) => {
    const match = line.text.match(productionHistory);

    if (match === null) return [];

    return [
      {
        where: line.number,
        message: `warning: "${match[0]}" tells how the work was produced, describe the change at this head for a reader who has only the base, the diff, and the tickets`,
      },
    ];
  });
}

function titleFindings(kind: Kind, title: string): Finding[] {
  const length = [...title].length;
  const tooLong: Finding[] =
    kind === "pr" && length > prTitleCap
      ? [
          {
            where: "title",
            message: `title is ${length} characters, cut it to ${prTitleCap} or fewer`,
          },
        ]
      : [];

  return [...tooLong, ...titleFormFindings(kind, title)];
}

function titleFormFindings(kind: Kind, title: string): Finding[] {
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
  const problems = [
    ...(args.title === undefined ? [] : titleFindings(args.kind, args.title)),
    ...headingFindings(body, shape),
    ...contentFindings(args.kind, body),
  ];
  const warnings = args.kind === "pr" ? historyWarnings(body) : [];

  for (const finding of [...problems, ...warnings].sort((a, b) => order(a) - order(b))) {
    console.log(`${args.bodyFile}:${finding.where}: ${finding.message}`);
  }

  return problems.length === 0 ? 0 : 1;
}

process.exitCode = main();
