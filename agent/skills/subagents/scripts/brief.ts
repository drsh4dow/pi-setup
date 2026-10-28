// Pure checks on a brief's text: required fields per role, placeholders a generator left
// behind, and the branches the brief names as inputs. The shell in launch.ts reads files,
// queries git, and decides the exit code.

export const ROLES = [
  "implementer",
  "explorer",
  "verifier",
  "merger",
  "pr-writer",
  "babysitter",
  "live-verifier",
  "persona",
  "assignment",
  "brief-auditor",
] as const;

export type Role = (typeof ROLES)[number];

export const KINDS = ["delegate", "owner"] as const;

export type Kind = (typeof KINDS)[number];

export interface Problem {
  readonly line: number | null;
  readonly message: string;
}

interface Line {
  readonly number: number;
  readonly text: string;
}

const TEMPLATE_FIELDS = [
  "GOAL",
  "KIND",
  "SCOPE",
  "AUTHORITY",
  "CONTEXT",
  "SKILLS",
  "ACCEPTANCE",
  "VERIFY",
  "TIMEBOX",
  "FORBIDDEN",
  "REPORT",
] as const;

type Field = (typeof TEMPLATE_FIELDS)[number] | "STEPS";

const FIELD_NAMES: readonly Field[] = [...TEMPLATE_FIELDS, "STEPS"];

// The persona and free-form assignment roles carry no template, so only the text checks apply.
function requiredFields(role: Role, collapsed: boolean): readonly Field[] {
  switch (role) {
    case "persona":
    case "assignment":
      return [];
    case "merger":
      return collapsed
        ? ["GOAL", "SCOPE", "STEPS", "REPORT"]
        : TEMPLATE_FIELDS.map((field) => (field === "VERIFY" ? "STEPS" : field));
    case "implementer":
    case "explorer":
    case "verifier":
    case "pr-writer":
    case "babysitter":
    case "live-verifier":
    case "brief-auditor":
      return collapsed ? ["GOAL", "SCOPE", "VERIFY", "REPORT"] : TEMPLATE_FIELDS;
    default: {
      const unexpected: never = role;
      throw new Error(`Unexpected role: ${String(unexpected)}`);
    }
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// Lines outside fenced code blocks, so a brief may quote shell and TypeScript verbatim.
function proseLines(text: string): Line[] {
  const kept: Line[] = [];
  let fence: string | null = null;

  for (const [index, line] of text.split("\n").entries()) {
    const marker = FENCE.exec(line)?.[1];

    if (fence !== null) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
      continue;
    }

    if (marker !== undefined) {
      fence = marker;
      continue;
    }

    kept.push({ number: index + 1, text: line });
  }

  return kept;
}

const INLINE_CODE = /`[^`\n]*`/g;

// Tokens a generator leaves when a value is missing. The first group can never be meant,
// even inside inline code; the second is legitimate in quoted code, so inline code is
// blanked out before it is matched.
const NEVER_MEANT: readonly RegExp[] = [
  /\[object Object\]/,
  /origin\/origin\//,
  /\/undefined\b|\bundefined\//,
];

// An angle-bracket slot such as `<sha>` or `<chunk id>`. Autolinks and addresses hold `:` or
// `@`, so they never match.
const UNFILLED: readonly RegExp[] = [
  /\bundefined\b/,
  /\bNaN\b/,
  /\$\{[^}]*\}/,
  /<(?:…|\.\.\.|[A-Za-z][\w .-]{0,40})>/,
];

function placeholderProblems(lines: readonly Line[]): Problem[] {
  return lines.flatMap(({ number, text }) => {
    const prose = text.replaceAll(INLINE_CODE, "``");
    const hit =
      NEVER_MEANT.find((pattern) => pattern.test(text)) ??
      UNFILLED.find((pattern) => pattern.test(prose));

    if (hit === undefined) return [];

    return [{ line: number, message: `unfilled placeholder: ${text.trim()}` }];
  });
}

const FIELD_LINE = new RegExp(
  String.raw`^(?:#+\s*)?(?:\*\*)?(${FIELD_NAMES.join("|")})(?:\*\*)?:?(?:\*\*)?(?:\s+(.*))?$`,
);

interface FieldValue {
  readonly field: Field;
  readonly line: number;
  readonly value: string;
}

// A field runs from its name at the start of a line to the next field name.
function fieldValues(lines: readonly Line[]): FieldValue[] {
  const fields: { field: Field; line: number; parts: string[] }[] = [];

  for (const { number, text } of lines) {
    const match = FIELD_LINE.exec(text);
    const field = FIELD_NAMES.find((name) => name === match?.[1]);

    if (field !== undefined) {
      fields.push({ field, line: number, parts: [match?.[2] ?? ""] });
      continue;
    }

    fields.at(-1)?.parts.push(text);
  }

  return fields.map(({ field, line, parts }) => ({
    field,
    line,
    value: parts.join("\n").trim(),
  }));
}

function isCollapsed(lines: readonly Line[]): boolean {
  const first = lines.find(({ text }) => text.trim() !== "");

  return first !== undefined && /^\s*COLLAPSED\b/.test(first.text);
}

function fieldProblems(lines: readonly Line[], role: Role, kind: Kind): Problem[] {
  const collapsed = isCollapsed(lines);
  const required = requiredFields(role, collapsed);

  if (collapsed) {
    const paragraph = lines.map(({ text }) => text).join("\n");

    return required
      .filter((field) => !new RegExp(String.raw`\b${field}\b`).test(paragraph))
      .map((field) => ({
        line: null,
        message: `collapsed ${role} brief does not name required field ${field}`,
      }));
  }

  const values = fieldValues(lines);

  const missing = required.flatMap((field): Problem[] => {
    const found = values.find((value) => value.field === field);

    if (found === undefined)
      return [{ line: null, message: `${role} brief is missing required field ${field}` }];

    if (found.value === "")
      return [{ line: found.line, message: `${role} brief has an empty field ${field}` }];

    return [];
  });

  const declared = /^\w+/.exec(values.find(({ field }) => field === "KIND")?.value ?? "")?.[0];

  if (declared === undefined || declared === kind) return missing;

  return [
    ...missing,
    { line: null, message: `brief says KIND ${declared}, but the launch is --kind ${kind}` },
  ];
}

export interface BriefCheck {
  readonly text: string;
  readonly role: Role;
  readonly kind: Kind;
  // A resume message is a directive to a running child, not a whole brief.
  readonly resume: boolean;
}

export function briefProblems(check: BriefCheck): Problem[] {
  if (check.text.trim() === "") return [{ line: null, message: "brief is empty" }];

  const lines = proseLines(check.text);
  const fields = check.resume ? [] : fieldProblems(lines, check.role, check.kind);

  return [...fields, ...placeholderProblems(lines)];
}

const SKILL_NAME = /^[a-z0-9-]+/;

// The skill names in the SKILLS field: items split on commas and a standalone "and", each
// the leading name once emphasis, backticks, and parentheticals are gone, so
// "**tdd** (red first), `unslop` and writing-good-commits" names three. The field is its
// line and the indented lines that continue it, as in the template, so the prose after a
// free-form brief's SKILLS line is not read as names. A field that opens with `none`,
// whatever reason follows, names nothing, and so does a brief of any role without the field.
export function briefSkills(text: string): readonly string[] {
  const field = fieldValues(proseLines(text)).find(({ field: name }) => name === "SKILLS");
  const [first = "", ...rest] = (field?.value ?? "").split("\n");
  const end = rest.findIndex((line) => !/^\s+\S/.test(line));
  const value = [first, ...rest.slice(0, end === -1 ? rest.length : end)].join(" ");
  const items = value
    .replaceAll(/\([^)]*\)/g, "")
    .replaceAll(/[*`]/g, "")
    .split(/,|\s+and\s+/);
  const names = items.flatMap((item) => {
    const name = SKILL_NAME.exec(item.trim().toLowerCase())?.[0];

    return name === undefined ? [] : [name];
  });

  return names[0] === "none" ? [] : [...new Set(names)];
}

const BRANCH = String.raw`[A-Za-z0-9._][A-Za-z0-9._/-]*`;

const REMOTE_BRANCH = new RegExp(String.raw`(?<![\w/.-])origin/(${BRANCH})`, "g");

const BASED_ON = new RegExp(
  String.raw`\b(?:based on|(?:branch(?:ed|es)?|created?) from)\s+\`?(?:origin/)?(${BRANCH})`,
  "g",
);

function branchName(raw: string): string {
  return (raw.split("..")[0] ?? "").replace(/[./]+$/, "");
}

// The branches a brief reads from: every `origin/<name>`, and the branch SCOPE bases the unit
// on. A branch the unit creates is written without `origin/`, so it is never an input.
export function inputBranches(text: string): string[] {
  const remote = [...text.matchAll(REMOTE_BRANCH)].map((match) => match[1] ?? "");
  const scope = fieldValues(proseLines(text)).find(({ field }) => field === "SCOPE")?.value ?? "";
  const based = [...scope.matchAll(BASED_ON)].map((match) => match[1] ?? "");

  return [...new Set([...remote, ...based].map(branchName))].filter(
    (name) => name !== "" && name !== "HEAD",
  );
}
