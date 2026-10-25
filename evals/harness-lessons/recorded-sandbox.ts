// A recorded run must not see what happened after its cut. The machine knows: the session's real
// state folder, later Pi sessions, the repository, and the recording's own story.md. Pi runs in a
// mount namespace (bwrap) where those paths are empty directories, apart from the run's own state
// folder and output directory. Only the run sees the empty directories, so live sessions and
// watchers that use the real folders keep working.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import {
  loadRecording,
  RECORDED_STATE,
  recordingDir,
  recordingFiles,
  seedRecordedState,
} from "./recorded.ts";
import type { SetupCheck } from "./setup-checks.ts";
import { liveStateFolder } from "./state-folder.ts";

const STATE_ROOT = dirname(liveStateFolder(RECORDED_STATE));

/** Every state folder, every Pi session, and the recorded working directory, where they exist. */
export function hiddenFromRecordedRun(): string[] {
  return [STATE_ROOT, join(homedir(), ".pi", "agent", "sessions"), loadRecording().cwd].filter(
    (path) => existsSync(path),
  );
}

/**
 * The command a recorded run's Pi follows: a mount namespace where the hidden paths are empty,
 * apart from the run's own state folder (seedRecordedState creates it) and its output directory.
 */
export function recordedSandbox(outputDir: string): [string, ...string[]] {
  const visible = [liveStateFolder(RECORDED_STATE), outputDir];

  return [
    "bwrap",
    "--dev-bind",
    "/",
    "/",
    "--die-with-parent",
    ...hiddenFromRecordedRun().flatMap((path) => ["--tmpfs", path]),
    ...visible.flatMap((path) => ["--bind", path, path]),
    "--",
  ];
}

/** The lines `command` prints inside the sandbox, or why it failed. */
function inSandbox(cwd: string, outputDir: string, command: readonly string[]) {
  const [bwrap, ...args] = [...recordedSandbox(outputDir), ...command];
  const result = spawnSync(bwrap ?? "bwrap", args, { cwd, encoding: "utf8", timeout: 60_000 });
  const lines = (result.stdout ?? "").split("\n").filter((line) => line !== "");

  return { ok: result.status === 0, lines, error: (result.stderr ?? "").trim() };
}

/** The first directory under the state root on the way to `path`, if `path` is under it. */
function topUnderStateRoot(path: string): string[] {
  const inside = relative(STATE_ROOT, path);

  return inside.startsWith("..") ? [] : [inside.split(sep)[0] ?? ""];
}

/**
 * Inside the sandbox, the state root holds only the run's state folder, seeded with the
 * recording's snapshot, and the sessions and the recorded working directory are empty. The
 * seeded folder is removed afterwards, since no run wrote it.
 */
export function sandboxChecks(workdir: string, outputDir: string): SetupCheck[] {
  const live = seedRecordedState();

  try {
    const others = hiddenFromRecordedRun().filter((path) => path !== STATE_ROOT);
    const expected = [...new Set([RECORDED_STATE, ...topUnderStateRoot(outputDir)])].toSorted();
    const root = inSandbox(workdir, outputDir, ["ls", "-A", STATE_ROOT]);
    const seen = root.lines.toSorted();

    const full = others.filter(
      (path) => inSandbox(workdir, outputDir, ["ls", "-A", path]).lines.length > 0,
    );

    const seeded = inSandbox(workdir, outputDir, ["find", live, "-type", "f"]).lines.length;
    const snapshot = recordingFiles(recordingDir()).state;

    const inSnapshot = existsSync(snapshot)
      ? readdirSync(snapshot, { recursive: true, withFileTypes: true }).filter((entry) =>
          entry.isFile(),
        ).length
      : 0;

    return [
      {
        name: "the sandbox shows only the run's state folder",
        ok: root.ok && seen.join(",") === expected.join(","),
        detail:
          `sees ${seen.join(", ") || "nothing"}; expected ${expected.join(", ")} ${root.error}`.trim(),
      },
      {
        name: "the sandbox empties the sessions and the recorded working directory",
        ok: full.length === 0,
        detail: full.join(", "),
      },
      {
        name: "the run's state folder starts as the recording's snapshot",
        ok: seeded === inSnapshot,
        detail: `${seeded} files seeded, ${inSnapshot} in the snapshot`,
      },
    ];
  } finally {
    rmSync(live, { recursive: true, force: true });
  }
}
