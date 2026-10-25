// Helpers the catchup and catchup-video tests share: the prepared catchup working directory, its
// stubs, and metric values and evidence.

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { catchupStubEnv } from "../catchup-stubs.ts";
import type { Metric } from "../metrics.ts";
import { GIFT_REGISTRY_STATE } from "../scenarios.ts";
import { liveStateFolder } from "../state-folder.ts";
import { git, prepared, temporary, type Prepared } from "./support.ts";

export function values(metrics: Readonly<Record<string, Metric>>) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, metric]) => [
      name,
      metric.kind === "unknown" ? "unknown" : metric.value,
    ]),
  );
}

export const evidence = (metric: Metric | undefined) =>
  metric?.kind === "unknown" ? metric.reason : (metric?.evidence ?? "");

/** A read-only metric's problems, without the changes it allowed. */
export const problems = (metric: Metric | undefined) =>
  evidence(metric).split("\nallowed: ")[0] ?? "";

/**
 * The state folder the run's tool calls name. The tests never write it: a run's files are read
 * from the copy the runner keeps in the output directory.
 */
export const LIVE = liveStateFolder(GIFT_REGISTRY_STATE);

/** The catchup working directory after setup, its local origin removed when the tests end. */
export function where(): Prepared {
  const at = prepared("catchup");

  temporary(dirname(git(at.workdir, "remote", "get-url", "origin")));

  return at;
}

/** Runs a stub as the run would, with the catchup stubs first on PATH. */
export function stub(at: Prepared, command: string, args: readonly string[]) {
  return spawnSync(command, args, {
    cwd: at.workdir,
    encoding: "utf8",
    env: { ...process.env, ...catchupStubEnv(at.outputDir, at.workdir) },
  });
}
