// The home directory one run's Pi processes see. Pi finds its harness at `~/.pi/agent`, and the
// harness names its own files by `$HOME/.pi/agent/...` (the subagent launch appendices, the babysit
// watcher), so a child that `pi-subagent` starts reaches the same harness only when HOME itself
// points at the arm. The run gets copies, not links, of every harness file, so no path in the run
// home leads into the arm's checkout or the live `~/.pi` repository: a write lands in the copy,
// and `cd` into the home finds no git repository. Entries of the real home outside `~/.pi` stay
// links, so tools, caches, and credentials behave as they do outside the eval, and
// `~/.local/state` is a fresh directory, which keeps the run's state folders out of the real one.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

/** The parts of a harness checkout an arm varies: everything else comes from the live agent dir. */
export const ARM_ENTRIES = ["SYSTEM.md", "skills", "prompts"] as const;

/**
 * What Pi needs from the live checkout outside `agent/`: the copied extensions import their
 * packages from `../node_modules`, and `build-bin-path.ts` puts `../../.build/bin` (`pi-subagent`,
 * `emit-to-pi`) on PATH, both resolved from the extension's own location. Nothing else, and
 * never `.git`.
 */
export const LIVE_ROOT_ENTRIES = [".build", "node_modules", "package.json"] as const;

/**
 * Live agent files that stay links: credentials whose refresh must reach the real file, or the
 * next real Pi holds a revoked token.
 */
export const LIVE_LINKED_FILES: readonly string[] = ["auth.json", "mcp-auth.json"];

export interface RunHome {
  readonly home: string;
  /** `~/.pi/agent` as the run sees it. */
  readonly agentDir: string;
  /** Where every Pi of the run that names no session directory writes its session. */
  readonly sessions: string;
  /** `~/.local/state` as the run sees it. */
  readonly state: string;
  /** The agent-dir entries copied from the arm, which `harnessDigest` covers. */
  readonly armEntries: readonly string[];
}

export function runHomePaths(home: string, armEntries: readonly string[] = ARM_ENTRIES): RunHome {
  const agentDir = join(home, ".pi", "agent");

  return {
    home,
    agentDir,
    sessions: join(agentDir, "sessions"),
    state: join(home, ".local", "state"),
    armEntries,
  };
}

/** Symlinks every entry of `source` into `target`, except the names in `skip`. */
function mirror(source: string, target: string, skip: readonly string[]) {
  mkdirSync(target, { recursive: true });

  for (const name of readdirSync(source)) {
    if (skip.includes(name)) continue;

    symlinkSync(join(source, name), join(target, name));
  }
}

// Symlinks inside a copied tree (node_modules/.bin) keep their relative targets.
const copy = (source: string, target: string) =>
  cpSync(source, target, { recursive: true, verbatimSymlinks: true });

/**
 * Builds the run's home under `home`: copies of the arm's system prompt, skills, and prompts, and
 * of the live agent dir's settings, extensions, and MCP servers; links to the live credentials and
 * to the live checkout's built binaries and packages; empty session and state directories.
 */
export function prepareRunHome({
  armRoot,
  home,
  realHome = homedir(),
}: {
  armRoot: string;
  home: string;
  realHome?: string;
}): RunHome {
  const liveRoot = join(realHome, ".pi");
  const liveAgent = join(liveRoot, "agent");
  const armAgent = join(armRoot, "agent");
  const live = readdirSync(liveAgent);

  // A file the arm adds next to its prompts, such as a new reference, belongs to the arm too.
  const armEntries = [
    ...ARM_ENTRIES,
    ...readdirSync(armAgent).filter((name) => !live.includes(name)),
  ];

  const paths = runHomePaths(home, armEntries);

  mirror(realHome, home, [".pi", ".local"]);
  mirror(join(realHome, ".local"), join(home, ".local"), ["state"]);
  mkdirSync(paths.state, { recursive: true });
  mkdirSync(paths.agentDir, { recursive: true });

  for (const name of LIVE_ROOT_ENTRIES) {
    if (existsSync(join(liveRoot, name)))
      symlinkSync(join(liveRoot, name), join(home, ".pi", name));
  }

  for (const name of live) {
    if (name === "sessions" || armEntries.includes(name)) continue;

    if (LIVE_LINKED_FILES.includes(name))
      symlinkSync(join(liveAgent, name), join(paths.agentDir, name));
    else copy(join(liveAgent, name), join(paths.agentDir, name));
  }

  for (const name of armEntries) copy(join(armAgent, name), join(paths.agentDir, name));

  mkdirSync(paths.sessions, { recursive: true });

  return paths;
}

/** The environment that points a process at the run's home. */
export function runHomeEnv(paths: RunHome, realHome = homedir()): NodeJS.ProcessEnv {
  return {
    HOME: paths.home,
    XDG_STATE_HOME: paths.state,
    // The `.build` and `node_modules` links resolve into the live checkout; git started there
    // must not climb into its repository.
    GIT_CEILING_DIRECTORIES: join(realHome, ".pi"),
  };
}

/** The files and links under `root`, or `root` itself when it is not a directory. */
function leaves(root: string): string[] {
  if (!lstatSync(root).isDirectory()) return [root];

  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        !entry.isDirectory() &&
        !relative(root, entry.parentPath).split("/").includes("node_modules") &&
        entry.name !== "node_modules",
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();
}

/**
 * A content hash of `entries` under an agent dir, by relative path and bytes, skipping
 * `node_modules`. The arm's source and the run's copy hash equal when the copy is faithful.
 */
export function harnessDigest(agentDir: string, entries: readonly string[]): string {
  const hash = createHash("sha256");

  for (const entry of entries.toSorted()) {
    const root = join(agentDir, entry);

    if (!existsSync(root)) {
      hash.update(`${entry}\0(missing)\0`);
      continue;
    }

    for (const leaf of leaves(root)) {
      const link = lstatSync(leaf).isSymbolicLink();

      hash.update(`${relative(agentDir, leaf)}\0`);
      hash.update(link ? `-> ${readlinkSync(leaf)}` : readFileSync(leaf));
      hash.update("\0");
    }
  }

  return hash.digest("hex");
}
