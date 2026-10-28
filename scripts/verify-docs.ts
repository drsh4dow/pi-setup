#!/usr/bin/env node

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { allowsUserInvocation } from "../agent/extensions/skill-visibility/user-invokable.ts";
import { isEvalFixturePath } from "./eval-fixture-folders.ts";

const root = process.cwd();

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((path) => !isEvalFixturePath(path))
  .filter((path) => existsSync(resolve(root, path)));

const errors: string[] = [];

function localReference(raw: string) {
  const target = raw
    .trim()
    .replace(/^<|>$/g, "")
    .split(/\s+["']/)[0];

  if (!target || /^[a-z][a-z+.-]*:/i.test(target) || target.startsWith("//")) return undefined;

  const hash = target.indexOf("#");
  const path = target.slice(0, hash === -1 ? undefined : hash).split("?", 1)[0];

  const fragment = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));

  return { path: decodeURIComponent(path), fragment };
}

function withoutFencedCode(markdown: string) {
  let fence: string | undefined;

  return markdown
    .split("\n")
    .map((line) => {
      if (fence) {
        const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];

        if (closing?.[0] === fence[0] && closing.length >= fence.length) fence = undefined;

        return "";
      }

      const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);

      if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
        fence = opening[1];

        return "";
      }

      return line;
    })
    .join("\n");
}

function headingAnchors(markdown: string) {
  const anchors = new Set<string>();
  const duplicates = new Map<string, number>();

  for (const match of withoutFencedCode(markdown).matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const heading = match[1]
      .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~]/g, "")
      .trim()
      .toLowerCase();

    const base = heading.replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
    const duplicate = duplicates.get(base) ?? 0;
    duplicates.set(base, duplicate + 1);
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
  }

  return anchors;
}

for (const markdown of files.filter((path) => extname(path).toLowerCase() === ".md")) {
  const text = withoutFencedCode(readFileSync(resolve(root, markdown), "utf8"));

  const targets = [
    ...[...text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]),
    ...[...text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map((match) => match[1]),
  ];

  for (const raw of targets) {
    const reference = localReference(raw);

    if (!reference) continue;

    const targetPath = reference.path
      ? resolve(root, dirname(markdown), reference.path)
      : resolve(root, markdown);

    if (!existsSync(targetPath)) {
      errors.push(`${markdown}: broken local link ${raw}`);
      continue;
    }

    if (
      reference.fragment &&
      extname(targetPath).toLowerCase() === ".md" &&
      !headingAnchors(readFileSync(targetPath, "utf8")).has(reference.fragment)
    ) {
      errors.push(`${markdown}: broken local anchor ${raw}`);
    }
  }
}

function extensionName(path: string) {
  return (
    path.match(/^agent\/extensions\/([^/]+)\/index\.ts$/)?.[1] ??
    path.match(/^agent\/extensions\/([^/]+)\.ts$/)?.[1]
  );
}

function skillName(path: string) {
  return path.match(/^agent\/skills\/([^/]+)\/SKILL\.md$/)?.[1];
}

const extensionNames = [
  ...new Set(files.map(extensionName).filter((name) => name !== undefined)),
].toSorted();

const inventory = [
  { heading: "Installed extensions", actual: extensionNames },
  {
    heading: "Installed skills",
    actual: files.map(skillName).filter((name) => name !== undefined),
  },
  {
    heading: "Installed prompts",
    actual: files
      .map((path) => path.match(/^agent\/prompts\/([^/]+)\.md$/)?.[1])
      .filter((name) => name !== undefined),
  },
  {
    heading: "Installed themes",
    actual: files
      .map((path) => path.match(/^agent\/themes\/([^/]+)\.json$/)?.[1])
      .filter((name) => name !== undefined),
  },
];

const inventoryFile = "docs/inventory.md";

const inventoryText = readFileSync(resolve(root, inventoryFile), "utf8");

// The text under a "### <heading>" of the inventory, up to the next heading of level 2 or 3.
function inventorySection(heading: string) {
  return (
    inventoryText.match(
      new RegExp(`^### ${heading}\\s*$([\\s\\S]*?)(?=^###? |(?![\\s\\S]))`, "m"),
    )?.[1] ?? ""
  );
}

for (const { heading, actual } of inventory) {
  const documented = [...inventorySection(heading).matchAll(/^[-|].*?`([^`]+)`/gm)].map(
    (match) => match[1],
  );

  const expected = [...new Set(actual)].toSorted();
  const found = [...new Set(documented)].toSorted();

  if (JSON.stringify(expected) !== JSON.stringify(found)) {
    errors.push(
      `${inventoryFile} ${heading}: found [${expected.join(", ")}], documented [${found.join(", ")}]`,
    );
  }
}

// Who can start a skill, as the inventory's Who column states it.
type Who = "you" | "agent" | "both";

// The two frontmatter keys that decide who can start a skill, as YAML parsed them.
type InvocationFlags = {
  readonly "disable-model-invocation"?: unknown;
  readonly "user-invokable"?: unknown;
};

// Pi hides a skill from the model's table only on an explicit `disable-model-invocation: true`.
// A hidden skill that /skill: also leaves out is a library skill: the agent reaches it by path
// from the router or another skill, and verify-skills fails when nothing points to it.
function whoFromFrontmatter(frontmatter: InvocationFlags): Who {
  const inSkillTable = frontmatter["disable-model-invocation"] !== true;
  const userCanStart = allowsUserInvocation(frontmatter);

  if (!userCanStart) return "agent";

  return inSkillTable ? "both" : "you";
}

const skillWho = new Map<string, Who>();

for (const path of files) {
  const name = skillName(path);

  if (name === undefined) continue;

  let frontmatter: InvocationFlags;

  try {
    frontmatter = parseFrontmatter<InvocationFlags>(
      readFileSync(resolve(root, path), "utf8"),
    ).frontmatter;
  } catch (error) {
    // The YAML parser's first line names the problem and its position; the rest is a code frame.
    const reason = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
    errors.push(`${path}: frontmatter does not parse: ${reason}`);
    continue;
  }

  skillWho.set(name, whoFromFrontmatter(frontmatter));
}

function tableCells(line: string) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

// Each row of a table in the given section whose header has a Who column.
function whoRows(section: string) {
  const lines = section.split("\n");
  const rows: { name: string; who: string }[] = [];
  let whoColumn = -1;

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("|")) {
      whoColumn = -1;
    } else if (/^\|[\s:|-]+\|\s*$/.test(line)) {
      whoColumn = tableCells(lines[index - 1] ?? "").indexOf("Who");
    } else if (whoColumn !== -1) {
      const cells = tableCells(line);
      const name = cells[0]?.match(/`([^`]+)`/)?.[1];

      if (name !== undefined) rows.push({ name, who: cells[whoColumn] ?? "" });
    }
  }

  return rows;
}

for (const { name, who } of whoRows(inventorySection("Installed skills"))) {
  const expected = skillWho.get(name);

  if (expected !== undefined && expected !== who) {
    errors.push(
      `${inventoryFile} Installed skills: ${name} is listed as ${who}, agent/skills/${name}/SKILL.md frontmatter makes it ${expected}`,
    );
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Documentation verified (${files.filter((path) => path.endsWith(".md")).length} Markdown files).`,
  );
}
