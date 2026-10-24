// When the parent learns each mid-run fact. A watcher polls the run while it lasts and marks a
// fact learned once its trigger fires: a fixed time after the first spawn, or the worker's first
// change to the repository. The parent's answers, reviews, and later briefs read the result, and
// the C+push arm drops the fact's push message in the worker's mailbox at that moment.

import { spawnSync } from "node:child_process";
import type { Scenario, Trigger } from "./scenario.ts";

const POLL_MS = 1000;

/** Whether the working directory differs from the base: an edited, new, or committed file. */
function edited(workdir: string, baseSha: string): boolean {
  const status =
    spawnSync("git", ["status", "--porcelain"], { cwd: workdir, encoding: "utf8" }).stdout ?? "";

  const head = (
    spawnSync("git", ["rev-parse", "HEAD"], { cwd: workdir, encoding: "utf8" }).stdout ?? ""
  ).trim();

  return status.trim() !== "" || (head !== "" && head !== baseSha);
}

export function fired(
  trigger: Trigger,
  {
    elapsedSeconds,
    workdir,
    baseSha,
  }: { elapsedSeconds: number; workdir: string; baseSha: string },
): boolean {
  switch (trigger.kind) {
    case "seconds":
      return elapsedSeconds >= trigger.seconds;
    case "first-edit":
      return edited(workdir, baseSha);
    default: {
      const exhaustive: never = trigger;

      return exhaustive;
    }
  }
}

/** Fact index to the seconds after the first spawn when the parent learned it. */
export type Learned = Map<number, number>;

/** Polls the triggers of `scenario`'s mid-run facts until `until` settles, recording each into `learned` once. */
export async function watchTriggers({
  scenario,
  workdir,
  baseSha,
  startedAt,
  learned,
  onLearn,
  until,
}: {
  scenario: Scenario;
  workdir: string;
  baseSha: string;
  startedAt: number;
  learned: Learned;
  onLearn: (index: number) => void;
  until: Promise<unknown>;
}): Promise<void> {
  if (scenario.knowledge.learned.length === 0) return;

  const state = { done: false };

  void until.finally(() => {
    state.done = true;
  });

  const poll = async (): Promise<void> => {
    if (state.done || learned.size === scenario.knowledge.learned.length) return;

    const elapsedSeconds = (Date.now() - startedAt) / 1000;

    for (const [index, fact] of scenario.knowledge.learned.entries()) {
      if (learned.has(index) || !fired(fact.trigger, { elapsedSeconds, workdir, baseSha }))
        continue;

      learned.set(index, elapsedSeconds);
      onLearn(index);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));

    return poll();
  };

  await poll();
}
