// The home directory one run's Pi processes see. Pi finds its harness at `~/.pi/agent`, and the
// harness names its own files by `$HOME/.pi/agent/...` (the subagent launch appendices, the babysit
// watcher), so a child that `pi-subagent` starts reaches the same harness only when HOME itself
// points at the arm. Every other entry of the real home is a symlink, so tools, caches, and
// credentials behave as they do outside the eval, and `~/.local/state` is a fresh directory, which
// keeps the run's state folders out of the real one.

import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The parts of a harness checkout an arm varies: everything else comes from the live agent dir. */
export const ARM_ENTRIES = ["SYSTEM.md", "skills", "prompts"] as const;

export interface RunHome {
  readonly home: string;
  /** `~/.pi/agent` as the run sees it. */
  readonly agentDir: string;
  /** Where every Pi of the run that names no session directory writes its session. */
  readonly sessions: string;
  /** `~/.local/state` as the run sees it. */
  readonly state: string;
}

export function runHomePaths(home: string): RunHome {
  const agentDir = join(home, ".pi", "agent");

  return {
    home,
    agentDir,
    sessions: join(agentDir, "sessions"),
    state: join(home, ".local", "state"),
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

/**
 * Builds the run's home under `home`: the arm's system prompt, skills, and prompts, with the live
 * agent dir's settings, credentials, extensions, and MCP servers, and empty session and state
 * directories.
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
  const paths = runHomePaths(home);
  const liveAgent = join(realHome, ".pi", "agent");
  const armAgent = join(armRoot, "agent");

  mirror(realHome, home, [".pi", ".local"]);
  mirror(join(realHome, ".local"), join(home, ".local"), ["state"]);
  mkdirSync(paths.state, { recursive: true });

  // Sibling worktrees of the live checkout are other agents' work, not this run's harness.
  mirror(join(realHome, ".pi"), join(home, ".pi"), ["agent", ".worktrees"]);
  mirror(liveAgent, paths.agentDir, [...ARM_ENTRIES, "sessions"]);

  for (const name of ARM_ENTRIES) symlinkSync(join(armAgent, name), join(paths.agentDir, name));

  // A file the arm adds next to its prompts, such as a new reference, belongs to the arm too.
  for (const name of readdirSync(armAgent)) {
    if (!existsSync(join(paths.agentDir, name))) {
      symlinkSync(join(armAgent, name), join(paths.agentDir, name));
    }
  }

  mkdirSync(paths.sessions, { recursive: true });

  return paths;
}
