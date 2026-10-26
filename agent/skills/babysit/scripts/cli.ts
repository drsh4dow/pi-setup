import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import {
  GhGitHubReader,
  WatcherQueryError,
  discoverStack,
  resolveContext,
} from "./github.ts";
import {
  runQueued,
  runSimple,
  statusQueryVerdict,
  verdictFactory,
  type WatchClock,
} from "./policy.ts";
import { renderJson, renderPretty } from "./render.ts";
import type * as T from "./types.ts";
import { nonEmpty, parsePrNumber } from "./types.ts";
import { type FeedbackReader, ghFeedbackReader } from "./feedback.ts";
import type { AttentionId } from "./monitor-state.ts";
import { type Lifetime, collectAck, runUntilMerged } from "./until-merged.ts";
export interface CliOptions {
  readonly owner: string | null;
  readonly repo: string | null;
  readonly pr: T.PrNumber | null;
  readonly mode: T.WatchMode;
  readonly stackPrs: readonly T.PrNumber[];
  readonly statusOnly: boolean;
  readonly pretty: boolean;
  readonly polling: T.PollingOptions;
  readonly lifetime: Lifetime;
}
function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new InvalidArgumentError("must be greater than zero");
  return parsed;
}
function nonNegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new InvalidArgumentError("must be zero or greater");
  return parsed;
}
function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new InvalidArgumentError("must be a positive integer");
  return parsed;
}
function prNumber(value: string): T.PrNumber {
  try {
    return parsePrNumber(Number(value.replace(/^#/, "")));
  } catch {
    throw new InvalidArgumentError("must be a positive integer");
  }
}
function stackPrList(value: string): T.NonEmpty<T.PrNumber> {
  const numbers = value.split(",").map((part) => prNumber(part.trim()));
  if (new Set(numbers).size !== numbers.length)
    throw new InvalidArgumentError("contains a duplicate PR");
  const parsed = nonEmpty(numbers);
  if (parsed === null) throw new InvalidArgumentError("cannot be empty");
  return parsed;
}
interface RawOptions {
  readonly owner?: string;
  readonly repo?: string;
  readonly pr?: T.PrNumber;
  readonly stack: boolean;
  readonly queuedStack: boolean;
  readonly stackPrs?: T.NonEmpty<T.PrNumber>;
  readonly interval: number;
  readonly sweepInterval: number;
  readonly timeout: number;
  readonly maxQueryErrors: number;
  readonly statusOnly: boolean;
  readonly allowDraft: boolean;
  readonly pretty: boolean;
  readonly untilMerged?: true;
  readonly untilReady?: true;
  readonly state?: string;
  readonly ack: readonly AttentionId[];
}
export function parseArgs(
  argv: readonly string[],
  io: Pick<CliRuntime, "stdout" | "stderr">
): CliOptions {
  const program = new Command("watch-pr")
    .description(
      [
        "Watch one pull request, a connected stack, or an immutable queued stack.",
        "",
        "Modes:",
        "  default        watch until every PR merges or closes: exit 8 with a",
        "                 batch on new attention, 0 once merged or closed;",
        "                 --until-merged names it",
        "  --until-ready  stop at merge-ready (exit 0) or at the first blocker",
        "                 (exit 2-7)",
        "  --status-only  print one status pass and exit 0",
        "",
        "JSON (NDJSON while polling) is the default; --pretty renders human text.",
      ].join("\n")
    )
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride()
    .option("--owner <owner>", "GitHub repository owner")
    .option("--repo <repo>", "GitHub repository name")
    .option("--pr <number>", "pull request number", prNumber)
    .addOption(
      new Option("--stack", "watch the connected open stack")
        .default(false)
        .conflicts("queuedStack")
    )
    .option(
      "--queued-stack",
      "watch the captured stack until all PRs merge",
      false
    )
    .option(
      "--stack-prs <n,...>",
      "frozen bottom-to-top queue (queued mode only)",
      stackPrList
    )
    .option("--interval <seconds>", "poll interval", positiveNumber, 60)
    .option(
      "--sweep-interval <seconds>",
      "whole-stack sweep interval",
      positiveNumber,
      300
    )
    .option(
      "--timeout <seconds>",
      "deadline; 0 disables it",
      nonNegativeNumber,
      0
    )
    .option(
      "--max-query-errors <count>",
      "consecutive query-error budget",
      positiveInteger,
      5
    )
    .option("--status-only", "print one status pass and exit 0", false)
    .option("--allow-draft", "do not treat a draft as a merge gate", false)
    .option("--pretty", "render human text instead of JSON", false)
    .option("--until-ready", "stop at merge-ready or at the first blocker")
    .option("--until-merged", "name the default mode")
    .option(
      "--state <directory>",
      "durable monitor state; default ~/.local/state/pi-agent/<repo>/babysit/<pr>, or <root-pr>-stack for a stack"
    )
    .option(
      "--ack <id>",
      "acknowledge a delivered attention item (repeatable)",
      collectAck,
      []
    );
  program.parse(argv, { from: "user" });
  const raw = program.opts<RawOptions>();
  if (raw.stackPrs !== undefined && !raw.queuedStack)
    program.error("error: --stack-prs requires --queued-stack");
  const modes = [
    raw.untilMerged === true && "--until-merged",
    raw.untilReady === true && "--until-ready",
    raw.statusOnly && "--status-only",
  ].filter((mode) => mode !== false);
  if (modes.length > 1)
    program.error(`error: ${modes.join(" and ")} are different modes; pass one`);
  let lifetime: Lifetime = {
    kind: "until-merged",
    stateDirectory: raw.state === undefined ? null : resolve(raw.state),
    acknowledge: raw.ack,
  };
  if (raw.untilReady === true || raw.statusOnly) {
    if (raw.state !== undefined || raw.ack.length > 0)
      program.error("error: --state and --ack belong to the default until-merged watch");
    lifetime = { kind: "until-ready" };
  }
  return {
    owner: raw.owner ?? null,
    repo: raw.repo ?? null,
    pr: raw.pr ?? null,
    mode: raw.queuedStack ? "queued-stack" : raw.stack ? "stack" : "single",
    stackPrs: raw.stackPrs ?? [],
    statusOnly: raw.statusOnly,
    pretty: raw.pretty,
    polling: {
      interval: raw.interval,
      sweepInterval: raw.sweepInterval,
      timeout: raw.timeout,
      maxQueryErrors: raw.maxQueryErrors,
      allowDraft: raw.allowDraft,
    },
    lifetime,
  };
}
export interface CliRuntime {
  readonly reader: T.GitHubReader;
  readonly clock: WatchClock;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  /** The user's home directory, under which the default monitor state lives. */
  readonly home: string;
}
function realRuntime(): CliRuntime {
  return {
    reader: new GhGitHubReader(),
    clock: {
      now: () => performance.now() / 1_000,
      observedAt: () => new Date().toISOString(),
      sleep: async (seconds) => {
        await delay(seconds * 1_000);
      },
    },
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    home: homedir(),
  };
}
export async function main(
  argv: readonly string[],
  runtime: CliRuntime = realRuntime(),
  feedback: FeedbackReader = ghFeedbackReader
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv, runtime);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    return error.exitCode === 0 ? 0 : 64;
  }
  const render = options.pretty ? renderPretty : renderJson;
  if (options.lifetime.kind === "until-merged")
    return runUntilMerged({
      runtime,
      feedback,
      pretty: options.pretty,
      owner: options.owner,
      repo: options.repo,
      pr: options.pr,
      mode: options.mode,
      stackPrs: options.stackPrs,
      polling: options.polling,
      stateDirectory: options.lifetime.stateDirectory,
      acknowledge: options.lifetime.acknowledge,
    });
  const emit = (verdict: T.ProgressVerdict): void =>
    runtime.stdout(render(verdict));
  let contexts: T.NonEmpty<T.PrContext>;
  try {
    const seed = await resolveContext({
      reader: runtime.reader,
      owner: options.owner,
      repo: options.repo,
      pr: options.pr ?? options.stackPrs[0] ?? null,
    });
    contexts =
      nonEmpty(options.stackPrs.map((number) => ({ ...seed, number }))) ??
      (options.mode === "single"
        ? [seed]
        : await discoverStack(runtime.reader, seed));
  } catch (error) {
    if (!(error instanceof WatcherQueryError)) throw error;
    const verdict = statusQueryVerdict(
      verdictFactory(runtime.clock, options.mode),
      1,
      error.failure
    );
    runtime.stdout(render(verdict));
    return verdict.exitCode;
  }
  const dependencies = { reader: runtime.reader, clock: runtime.clock, emit };
  const verdict =
    options.mode === "queued-stack" && !options.statusOnly
      ? await runQueued({ dependencies, contexts, options: options.polling })
      : await runSimple({
          dependencies,
          contexts,
          mode: options.mode,
          statusOnly: options.statusOnly,
          options: options.polling,
        });
  runtime.stdout(render(verdict));
  return verdict.exitCode;
}
