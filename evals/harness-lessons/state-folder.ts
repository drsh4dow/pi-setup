// A run's state folder: where the harness keeps the artifacts of the repository a run works in.
// agent/SYSTEM.md names it after the repository name of `origin`, so every run of one fixture
// shares it. The runner moves it into the run's output directory once the run ends, so the next
// run starts without it and grading still finds it.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The state folder of a repository named `name`, where a run writes it. */
export function liveStateFolder(name: string): string {
  return join(homedir(), ".local", "state", "pi-agent", name);
}

/** Where the runner keeps a run's state folder after the run. Absent for runs from before. */
export function keptStateFolder(outputDir: string): string {
  return join(outputDir, "state-folder");
}

/**
 * Moves the state folder at `live` into the run's output directory, replacing an earlier copy
 * there. The copy exists afterwards, empty when the run wrote no state folder. It keeps each
 * file's modification time, which the grade reads as when the run wrote it.
 */
export function keepStateFolder({ live, outputDir }: { live: string; outputDir: string }) {
  const kept = keptStateFolder(outputDir);

  rmSync(kept, { recursive: true, force: true });

  if (existsSync(live))
    cpSync(live, kept, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  else mkdirSync(kept, { recursive: true });

  rmSync(live, { recursive: true, force: true });
}
