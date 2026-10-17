#!/usr/bin/env node

// Ports pstack (github.com/cursor/plugins, directory pstack/) into this Pi setup.
//
//   render <pstack-dir> <out-dir>        write the mechanically ported tree to <out-dir>
//   sync <pstack-dir> [<old-pstack-dir>] port into agent/; with the previously synced
//                                        upstream, three-way merge so local edits survive
//   check                                fail on Cursor-only vocabulary in the ported files
//
// Rendering only does what is safe to do mechanically: file placement, relative links,
// frontmatter, and skill command syntax. Everything that needs judgment (subagent calls,
// model roles, Cursor built-ins) is a local edit that `sync` carries forward and `check`
// keeps from regressing. README.md's "Syncing pstack" section maps each Cursor concept.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

const agentDirectory = "agent";

const skippedSkills = new Set([
  // A Grok Bot webhook UI generator, with no Pi counterpart.
  "make-bot-ui",
  // Writes Cursor's model rule; the subagents skill owns the role table instead.
  "setup-pstack",
]);

const skippedFiles = new Set([
  // Becomes agent/SYSTEM.md, which is maintained by hand.
  "skills/poteto-mode/SKILL.md",
  // Cleans macOS simulators and Cursor's chat stores.
  "skills/poteto-mode/playbooks/worktree-cleanup.md",
  "skills/poteto-mode/scripts/worktree-audit.sh",
]);

// Skills that only run when the user types their command.
const commandOnlySkills = new Set([
  "bro",
  "create-verification-skill",
  "in-your-own-words",
  "ketchup",
  "maintain-verification-skill",
  "poteto-help",
  "teach",
]);

// Skills the model applies on its own, kept out of `/skill:` autocomplete.
const commandHiddenSkills = new Set([
  "benchmark-checklist",
  "technical-writing",
  "typescript-best-practices",
  "unslop",
]);

function hiddenFromCommands(skill: string) {
  return skill.startsWith("principle-") || commandHiddenSkills.has(skill);
}

function destination(upstreamPath: string) {
  if (skippedFiles.has(upstreamPath)) return undefined;

  if (upstreamPath === "agents/comment-sicko.md")
    return "skills/no-comments/references/comment-sicko.md";

  const supportFile = upstreamPath.match(/^skills\/poteto-mode\/(.+)$/)?.[1];

  if (supportFile !== undefined) return `poteto/${supportFile}`;

  const skill = upstreamPath.match(/^skills\/([^/]+)\//)?.[1];

  if (skill === undefined || skippedSkills.has(skill)) return undefined;

  return upstreamPath;
}

function filesUnder(root: string, directory = ""): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(directory, entry.name);

    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : filesUnder(root, path);

    return [path];
  });
}

function upstreamFiles(pstack: string) {
  const files = new Map<string, string>();

  for (const upstreamPath of [...filesUnder(pstack, "skills"), ...filesUnder(pstack, "agents")]) {
    const target = destination(upstreamPath);

    if (target !== undefined) files.set(upstreamPath, target);
  }

  return files;
}

function portedSkills(files: Map<string, string>) {
  return new Set(
    [...files.values()].flatMap(
      (target) => target.match(/^skills\/([^/]+)\/SKILL\.md$/)?.[1] ?? [],
    ),
  );
}

// Re-points a relative link at the target's new location. Targets that were not ported keep
// their upstream text, so verify-docs reports them as broken links to fix by hand.
function rewriteLinks(text: string, upstreamPath: string, files: Map<string, string>) {
  const target = files.get(upstreamPath);

  if (target === undefined) return text;

  return text.replace(
    /\]\((?![a-z][a-z+.-]*:|#|\/)([^)\s#]+)(#[^)\s]*)?\)/gi,
    (link, path: string, fragment = "") => {
      const linkedUpstream = posix.normalize(posix.join(posix.dirname(upstreamPath), path));
      const linkedTarget = files.get(linkedUpstream) ?? directoryTarget(linkedUpstream, files);

      if (linkedTarget === undefined) return link;

      if (posix.join(posix.dirname(target), path).replace(/\/$/, "") === linkedTarget) return link;

      const trailingSlash = path.endsWith("/") ? "/" : "";

      return `](${posix.relative(posix.dirname(target), linkedTarget) || "."}${trailingSlash}${fragment})`;
    },
  );
}

function directoryTarget(upstreamDirectory: string, files: Map<string, string>) {
  const prefix = `${upstreamDirectory.replace(/\/$/, "")}/`;

  for (const [upstreamPath, target] of files) {
    if (upstreamPath.startsWith(prefix))
      return posix.join(
        dirname(target),
        posix.relative(posix.dirname(upstreamPath), upstreamDirectory),
      );
  }

  return undefined;
}

function rewriteFrontmatter(text: string, skill: string) {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);

  if (frontmatter === null) return text;

  const lines = frontmatter[1]
    .split("\n")
    .filter((line) => commandOnlySkills.has(skill) || line !== "disable-model-invocation: true");

  if (skill === "unslop") {
    const description = lines.indexOf("description: Cut AI tells from any writing.");
    lines[description] =
      "description: Cut AI tells from any writing. Use for any prose surface, your reply to the user included.";
  }

  if (hiddenFromCommands(skill)) {
    const description = lines.findIndex((line) => line.startsWith("description:"));
    lines.splice(description + 1, 0, "user-invokable: false");
  }

  return `---\n${lines.join("\n")}\n---\n${text.slice(frontmatter[0].length)}`;
}

function rewriteCommands(text: string, skills: Set<string>) {
  return text.replace(
    /(^|[\s`("'[])\/([a-z][a-z-]*)(?![\w/-])/gm,
    (command, prefix: string, name: string) =>
      skills.has(name) ? `${prefix}/skill:${name}` : command,
  );
}

function render(pstack: string, out: string) {
  const files = upstreamFiles(pstack);
  const skills = portedSkills(files);

  for (const [upstreamPath, target] of files) {
    let text = readFileSync(join(pstack, upstreamPath), "utf8");

    if (upstreamPath.endsWith(".md")) {
      const skill = target.match(/^skills\/([^/]+)\/SKILL\.md$/)?.[1];

      if (skill !== undefined) text = rewriteFrontmatter(text, skill);

      text = rewriteLinks(text, upstreamPath, files);
      text = rewriteCommands(text, skills);
      text = text.replaceAll(".cursor/skills/", ".agents/skills/");
    }

    const outputPath = join(out, target);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, text);
  }

  return [...files.values()];
}

function readIfPresent(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function mergeFile(localPath: string, base: string, upstream: string) {
  const scratch = mkdtempSync(join(tmpdir(), "pstack-merge-"));

  try {
    const basePath = join(scratch, "base");
    const upstreamPath = join(scratch, "upstream");
    writeFileSync(basePath, base);
    writeFileSync(upstreamPath, upstream);

    // Merges in place. A positive status counts the conflicts; a negative one is an error.
    const result = spawnSync(
      "git",
      [
        "merge-file",
        "-L",
        "local",
        "-L",
        "base",
        "-L",
        "upstream",
        localPath,
        basePath,
        upstreamPath,
      ],
      { encoding: "utf8" },
    );

    if (result.status === null || result.status < 0 || result.status > 127)
      throw new Error(`git merge-file failed for ${localPath}: ${result.stderr}`, {
        cause: result.error,
      });

    return result.status > 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function sync(pstack: string, previousPstack: string | undefined) {
  const scratch = mkdtempSync(join(tmpdir(), "pstack-render-"));
  const report: string[] = [];

  try {
    const upstreamDirectory = join(scratch, "upstream");
    const baseDirectory = join(scratch, "base");
    const targets = render(pstack, upstreamDirectory);
    const baseTargets = previousPstack === undefined ? [] : render(previousPstack, baseDirectory);

    for (const target of targets) {
      const localPath = join(agentDirectory, target);
      const upstream = readFileSync(join(upstreamDirectory, target), "utf8");
      const local = readIfPresent(localPath);
      const base = readIfPresent(join(baseDirectory, target));

      if (local === undefined && base !== undefined) {
        report.push(`kept deleted: ${localPath}`);
      } else if (previousPstack === undefined || local === undefined || local === base) {
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, upstream);
      } else if (mergeFile(localPath, base ?? "", upstream)) {
        report.push(`conflict: ${localPath}`);
      }
    }

    for (const target of baseTargets.filter((path) => !targets.includes(path))) {
      const localPath = join(agentDirectory, target);

      if (readIfPresent(localPath) === readFileSync(join(baseDirectory, target), "utf8")) {
        rmSync(localPath);
        report.push(`removed upstream: ${localPath}`);
      } else if (existsSync(localPath)) {
        report.push(`removed upstream, edited locally: ${localPath}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(report.length === 0 ? "pstack synced cleanly." : report.join("\n"));
}

const cursorVocabulary: [RegExp, string][] = [
  [
    /\bsubagent_type\b|\bTask (?:tool|calls?|subagents?)\b|`Task`|run_in_background|environment: "cloud"|\bpoteto-agent\b|generalPurpose|readonly: (?:true|false)|[Cc]loud agents?\b/,
    "a subagent started with `pi-subagent`, per the subagents skill",
  ],
  [/\bAskQuestion\b/, "a plain question at the end of the reply"],
  [/pstack-models|setup-pstack|\bgrok\b/i, "a role in the subagents skill's model table"],
  [/\/loop\b/, "a background terminal whose completion wakes the agent"],
  [
    /control-ui|control-cli|cursor-team-kit/,
    "agent-browser for UIs, background terminals for CLIs and TUIs",
  ],
  [/\bcreate-skill\b/, "the writing-for-agents skill"],
  [/agent-transcripts|\.cursor\b/, "Pi session files under the directory of $PI_SESSION_FILE"],
  [
    /\/poteto-mode\b|poteto-mode skill|\bCursor\b(?! Bugbot)/,
    "the Pi equivalent named in README.md's pstack mapping",
  ],
];

function check() {
  const markdown = [
    join(agentDirectory, "SYSTEM.md"),
    ...["skills", "poteto"].flatMap((directory) =>
      filesUnder(join(agentDirectory, directory)).map((path) =>
        join(agentDirectory, directory, path),
      ),
    ),
  ];

  const findings: string[] = [];

  for (const path of markdown.filter((file) => file.endsWith(".md"))) {
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, index) => {
        for (const [pattern, replacement] of cursorVocabulary) {
          const match = line.match(pattern);

          if (match !== null)
            findings.push(`${path}:${index + 1}: "${match[0]}" is Cursor-only; use ${replacement}`);
        }
      });
  }

  if (findings.length > 0) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  }
}

const [command, ...args] = process.argv.slice(2);

if (command === "render" && args.length === 2) {
  render(args[0], args[1]);
} else if (command === "sync" && (args.length === 1 || args.length === 2)) {
  sync(args[0], args[1]);
} else if (command === "check" && args.length === 0) {
  check();
} else {
  console.error(
    "usage: pstack-port.ts render <pstack-dir> <out-dir> | sync <pstack-dir> [<old-pstack-dir>] | check",
  );
  process.exitCode = 64;
}
