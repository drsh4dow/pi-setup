// How one worker round is launched: its Pi arguments, the environment the push arm adds, the
// standing orders a later spawn carries, and the prompt of a follow-up round.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutHarnessArgs } from "../lib/pi-run.ts";
import { delegateFile, protocolFile, PUSH_EXTENSION, type Arm } from "./arms.ts";
import type { RoundRecord } from "./record.ts";
import type { Scenario } from "./scenario.ts";
import type { Learned } from "./timeline.ts";
import type { RunPaths } from "./workdir.ts";

export interface Settings {
  readonly harness: string;
  readonly harnessHead: string;
  readonly thinking: string;
  readonly timeoutMinutes: number | undefined;
  readonly latencySeconds: number;
  readonly parentModel: string;
  readonly parentThinking: string;
  readonly askTimeoutMinutes: number;
}

export interface PlannedRun {
  readonly scenario: Scenario;
  readonly arm: Arm;
  readonly model: string;
  readonly trial: number;
  readonly dir: string;
}

export function followUpPrompt({
  brief,
  directive,
  report,
}: {
  brief: string;
  directive: string;
  report: string;
}): string {
  return [
    brief,
    "FOLLOW-UP ROUND. A previous worker ran this brief in this working directory; its work is in the working tree and on the branch. Your parent reviewed its report and sends the directive below. Carry out the brief with the directive applied.",
    "",
    "DIRECTIVE",
    directive,
    "",
    "PRIOR REPORT",
    report,
  ].join("\n");
}

export interface Launch {
  readonly prompt: string;
  readonly trigger: RoundRecord["trigger"];
  /** The session to resume, or none for a fresh worker. */
  readonly resume: string | null;
}

export function workerArgs(
  run: PlannedRun,
  settings: Settings,
  launch: Launch,
  sessionDir: string,
): string[] {
  const session =
    launch.resume === null ? ["--session-dir", sessionDir] : ["--session", launch.resume];

  return [
    "-p",
    "--model",
    run.model,
    "--thinking",
    settings.thinking,
    ...session,
    ...checkoutHarnessArgs(settings.harness),
    "--append-system-prompt",
    protocolFile(run.arm, settings.harness),
    "--append-system-prompt",
    delegateFile(settings.harness),
    ...(run.arm.push ? ["--extension", PUSH_EXTENSION] : []),
    launch.prompt,
  ];
}

export function displayCommand(settings: Settings, args: readonly string[]): string {
  const systemPrompt = readFileSync(join(settings.harness, "agent", "SYSTEM.md"), "utf8");

  const shown = args.map((arg) => {
    if (arg === systemPrompt)
      return `<contents of ${join(settings.harness, "agent", "SYSTEM.md")}>`;

    return /^[\w./:=@+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
  });

  return `pi ${shown.join(" ")}`;
}

export function pushEnv(run: PlannedRun, paths: RunPaths): NodeJS.ProcessEnv {
  if (!run.arm.push) return {};

  return { WQ_MAILBOX: paths.mailbox, WQ_PUSH_LOG: paths.pushLog };
}

/** The standing orders the parent has appended to its register since the first spawn. */
export function lateOrders(run: PlannedRun, learned: Learned): string[] {
  return run.scenario.knowledge.learned.flatMap((fact, index) =>
    learned.has(index) && fact.order !== null ? [fact.order] : [],
  );
}
