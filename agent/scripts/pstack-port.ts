#!/usr/bin/env node

// Ports pstack (github.com/cursor/plugins, directory pstack/) into this Pi setup.
//
//   sync [<ref>]  port upstream <ref> (default origin/main) into agent/, three-way merged
//                 against the commit in pstack-synced-commit.txt so local edits survive
//   check         fail on Cursor-only vocabulary in the ported files
//
// Rendering only does what is safe to do mechanically: file placement, relative links,
// frontmatter, and skill command syntax. Everything that needs judgment (subagent calls,
// model roles, Cursor built-ins) is a local edit that `sync` carries forward and `check`
// keeps from regressing. README.md's "pstack" section maps each Cursor concept.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

const agentDirectory = "agent";

const pinFile = join(agentDirectory, "scripts", "pstack-synced-commit.txt");

const upstreamRepository = "https://github.com/cursor/plugins.git";

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

type Invocation = "user-only" | "both" | "model-only";

// Upstream marks almost every skill command-only, so each one needs a decision here.
const invocations = new Map<string, Invocation>(
  Object.entries({
    architect: "both",
    arena: "both",
    "automate-me": "both",
    "benchmark-checklist": "model-only",
    "blast-radius": "both",
    bro: "user-only",
    correct: "both",
    "create-formal-verification-skill": "user-only",
    "create-verification-skill": "user-only",
    "figure-it-out": "both",
    how: "both",
    "in-your-own-words": "user-only",
    interrogate: "both",
    ketchup: "user-only",
    "maintain-formal-verification-skill": "both",
    "maintain-verification-skill": "user-only",
    "no-comments": "both",
    "poteto-help": "user-only",
    recall: "both",
    reflect: "both",
    sharpen: "both",
    "show-me-your-work": "both",
    swarm: "both",
    tdd: "both",
    teach: "user-only",
    "technical-writing": "model-only",
    "typescript-best-practices": "model-only",
    unslop: "model-only",
    why: "both",
  } satisfies Record<string, Invocation>),
);

function skillInvocation(skill: string) {
  if (skill.startsWith("principle-")) return "model-only";

  return invocations.get(skill);
}

const commandOnlyLine = "disable-model-invocation: true";

const invocationLines: Record<Invocation, string[]> = {
  "user-only": [commandOnlyLine],
  both: [],
  "model-only": ["user-invokable: false"],
};

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

const frontmatterPattern = /^---\n([\s\S]*?)\n---\n/;

function editFrontmatter(text: string, edit: (lines: string[]) => string[]) {
  const frontmatter = text.match(frontmatterPattern);

  if (frontmatter === null) return text;

  const lines = edit(frontmatter[1].split("\n"));

  return `---\n${lines.join("\n")}\n---\n${text.slice(frontmatter[0].length)}`;
}

function withInvocation(lines: string[], invocation: Invocation) {
  const kept = lines.filter((line) => !/^(?:disable-model-invocation|user-invokable):/.test(line));
  let insertAt = kept.findIndex((line) => line.startsWith("description:")) + 1;

  while (insertAt > 0 && insertAt < kept.length && /^\s/.test(kept[insertAt])) insertAt += 1;

  kept.splice(insertAt, 0, ...invocationLines[invocation]);

  return kept;
}

function rewriteFrontmatter(text: string, skill: string) {
  return editFrontmatter(text, (lines) => {
    const invocation = skillInvocation(skill);
    const rewritten = invocation === undefined ? lines : withInvocation(lines, invocation);

    if (skill === "unslop") {
      const description = rewritten.indexOf("description: Cut AI tells from any writing.");
      rewritten[description] =
        "description: Cut AI tells from any writing. Use for any prose surface, your reply to the user included.";
    }

    return rewritten;
  });
}

function classifySkills(pstack: string, files: Map<string, string>) {
  const classified = new Map<string, Invocation>();
  const missing: string[] = [];

  for (const skill of portedSkills(files)) {
    const invocation = skillInvocation(skill);

    if (invocation !== undefined) {
      classified.set(skill, invocation);
      continue;
    }

    const upstream = readFileSync(join(pstack, "skills", skill, "SKILL.md"), "utf8");
    const frontmatter = upstream.match(frontmatterPattern)?.[1].split("\n") ?? [];

    const upstreamChoice = frontmatter.includes(commandOnlyLine)
      ? "Upstream makes it command-only."
      : "Upstream lets the model load it.";

    missing.push(
      `skills/${skill}: new upstream skill. Add it to \`invocations\` in agent/scripts/pstack-port.ts as "user-only", "both", or "model-only". ${upstreamChoice}`,
    );
  }

  if (missing.length > 0) throw new Error(missing.join("\n"));

  return classified;
}

function rewriteCommands(text: string, skills: Set<string>) {
  return text.replace(
    /(^|[\s`("'[])\/([a-z][a-z-]*)(?![\w/-])/gm,
    (command, prefix: string, name: string) =>
      skills.has(name) ? `${prefix}/skill:${name}` : command,
  );
}

function permissions(path: string) {
  try {
    return statSync(path).mode & 0o777;
  } catch (error) {
    throw new Error(`could not read the file mode of ${path}`, { cause: error });
  }
}

function isExecutable(mode: number) {
  return (mode & 0o100) !== 0;
}

function render(pstack: string, out: string) {
  const files = upstreamFiles(pstack);
  const skills = portedSkills(files);
  const executableTargets = new Map<string, boolean>();

  for (const [upstreamPath, target] of files) {
    const source = join(pstack, upstreamPath);
    let text = readFileSync(source, "utf8");

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
    executableTargets.set(target, isExecutable(permissions(source)));
  }

  return executableTargets;
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

// Node applies the mode only when it creates the file; matchExecutableBit fixes existing ones.
function writeLocal(localPath: string, text: string, executable: boolean) {
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, text, { mode: executable ? 0o777 : 0o666 });
}

function matchExecutableBit(localPath: string, executable: boolean) {
  const mode = permissions(localPath);

  if (isExecutable(mode) === executable) return undefined;

  const executeBits = 0o111;
  let next = mode & ~executeBits;
  let change = "made non-executable";

  if (executable) {
    next = mode | executeBits;
    change = "made executable";
  }

  try {
    chmodSync(localPath, next);
  } catch (error) {
    throw new Error(`could not chmod ${next.toString(8)} ${localPath}`, { cause: error });
  }

  return `${change}: ${localPath}`;
}

function overrideMergedInvocations(classified: Map<string, Invocation>) {
  for (const [skill, invocation] of classified) {
    const localPath = join(agentDirectory, "skills", skill, "SKILL.md");
    const local = readIfPresent(localPath);

    if (local === undefined) continue;

    const rewritten = editFrontmatter(local, (lines) => withInvocation(lines, invocation));

    if (rewritten !== local) writeFileSync(localPath, rewritten);
  }
}

function updateClone() {
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const clone = join(cacheHome, "pi-setup", "cursor-plugins");

  if (existsSync(clone)) {
    try {
      execFileSync("git", ["-C", clone, "fetch", "--quiet", "origin"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
    } catch (error) {
      throw new Error(`git fetch from ${upstreamRepository} into ${clone} failed`, {
        cause: error,
      });
    }

    return clone;
  }

  mkdirSync(dirname(clone), { recursive: true });

  try {
    execFileSync(
      "git",
      ["clone", "--quiet", "--filter=blob:none", "--no-checkout", upstreamRepository, clone],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  } catch (error) {
    throw new Error(`git clone of ${upstreamRepository} into ${clone} failed`, { cause: error });
  }

  return clone;
}

function resolveCommit(clone: string, ref: string) {
  try {
    return execFileSync("git", ["-C", clone, "rev-parse", "--verify", `${ref}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  } catch (error) {
    throw new Error(`git rev-parse could not resolve ${ref} to a commit in ${clone}`, {
      cause: error,
    });
  }
}

function archivePstack(clone: string, commit: string) {
  try {
    return execFileSync("git", ["-C", clone, "archive", "--format=tar", commit, "pstack"], {
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (error) {
    throw new Error(`git archive of pstack/ at ${commit} failed`, { cause: error });
  }
}

function extractPstack(clone: string, commit: string, directory: string) {
  const archive = archivePstack(clone, commit);
  mkdirSync(directory, { recursive: true });

  try {
    execFileSync("tar", ["-x", "-C", directory], {
      input: archive,
      stdio: ["pipe", "ignore", "inherit"],
    });
  } catch (error) {
    throw new Error(`tar could not extract pstack/ at ${commit} into ${directory}`, {
      cause: error,
    });
  }

  return join(directory, "pstack");
}

function sync(ref: string) {
  const pinned = readFileSync(pinFile, "utf8").trim();
  const clone = updateClone();
  const commit = resolveCommit(clone, ref);
  const scratch = mkdtempSync(join(tmpdir(), "pstack-sync-"));
  const report: string[] = [];

  try {
    const basePstack = extractPstack(clone, pinned, join(scratch, "base-source"));
    const upstreamPstack = extractPstack(clone, commit, join(scratch, "upstream-source"));
    const classified = classifySkills(upstreamPstack, upstreamFiles(upstreamPstack));
    const upstreamDirectory = join(scratch, "upstream");
    const baseDirectory = join(scratch, "base");
    const targets = render(upstreamPstack, upstreamDirectory);
    const baseTargets = render(basePstack, baseDirectory);

    for (const [target, executable] of targets) {
      const localPath = join(agentDirectory, target);
      const upstream = readFileSync(join(upstreamDirectory, target), "utf8");
      const local = readIfPresent(localPath);
      const base = readIfPresent(join(baseDirectory, target));

      if (local === undefined && base !== undefined) {
        report.push(`kept deleted: ${localPath}`);
        continue;
      }

      if (local === undefined) {
        writeLocal(localPath, upstream, executable);
        report.push(`added upstream: ${localPath}`);
        continue;
      }

      if (local === base) {
        writeLocal(localPath, upstream, executable);
      } else if (mergeFile(localPath, base ?? "", upstream)) {
        report.push(`conflict: ${localPath}`);
      }

      const modeChange = matchExecutableBit(localPath, executable);

      if (modeChange !== undefined) report.push(modeChange);
    }

    for (const target of [...baseTargets.keys()].filter((path) => !targets.has(path))) {
      const localPath = join(agentDirectory, target);

      if (readIfPresent(localPath) === readFileSync(join(baseDirectory, target), "utf8")) {
        rmSync(localPath);
        report.push(`removed upstream: ${localPath}`);
      } else if (existsSync(localPath)) {
        report.push(`removed upstream, edited locally: ${localPath}`);
      }
    }

    for (const upstreamPath of skippedFiles) {
      const base = readIfPresent(join(basePstack, upstreamPath));

      if (base !== readIfPresent(join(upstreamPstack, upstreamPath)))
        report.push(`changed upstream, port by hand: ${upstreamPath}`);
    }

    overrideMergedInvocations(classified);
    writeFileSync(pinFile, `${commit}\n`);
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

try {
  if (command === "sync" && args.length <= 1) {
    const [ref = "origin/main"] = args;
    sync(ref);
  } else if (command === "check" && args.length === 0) {
    check();
  } else {
    console.error("usage: pstack-port.ts sync [<ref>] | check");
    process.exitCode = 64;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
