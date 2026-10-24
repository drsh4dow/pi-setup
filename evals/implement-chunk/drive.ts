// Drives one orchestrator run in print mode with session continuation. The first turn runs the
// prompt; whenever Pi exits, the scripted user reads the turn's last text and replies through
// `pi --session <file> -p`. Meanwhile a side loop reads the root session and merges each final PR
// the orchestrator has called merge-ready, because Pi waits on the orchestrator's until-merged
// watcher and the merge must happen while it waits.
//
// The run is about the chunk's own final PRs: those the orchestrator's plan.md names when they
// have all merged. From that moment the set is frozen, the user merges nothing more, and a PR
// opened later is work beyond the chunk, which neither keeps the run going nor counts.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { runPi, sessionFile, writeAtomically, type PiResult } from "../lib/pi-run.ts";
import { killProcessesWithEnv } from "../harness-lessons/workdir.ts";
import { sessionCost } from "./cost.ts";
import { call, readGitHub } from "./fakegh.ts";
import { sessionFiles } from "./isolation.ts";
import { decide, mergeReadyClaims, type Reason } from "./user.ts";
import { OWNER, type World } from "./world.ts";

export interface DriveSettings {
  readonly model: string;
  readonly thinking: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly maxTurns: number;
  /** Stops the run once root and child sessions together have cost this much. */
  readonly maxCostUsd: number;
}

export const HumanTurn = Schema.Struct({
  at: Schema.String,
  reason: Schema.Literals(["intake", "re-ask", "merged", "beyond-chunk", "default", "nudge"]),
  /** The end of the orchestrator text the reply answers. */
  answering: Schema.String,
  reply: Schema.String,
});

export const HumanMerge = Schema.Struct({
  at: Schema.String,
  pr: Schema.Int,
  ok: Schema.Boolean,
  /** The orchestrator's sentence the user took as the merge-ready claim; absent in older records. */
  claim: Schema.optionalKey(Schema.String),
  detail: Schema.String,
});

export type HumanMerge = typeof HumanMerge.Type;

export const PiTurn = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  durationMs: Schema.Finite,
});

export const ChunkFinalPrs = Schema.Struct({
  numbers: Schema.Array(Schema.Int),
  /** `plan.md` when the plan named them, else every PR into `main` at the time they had all merged. */
  source: Schema.Literals(["plan.md", "every PR into main"]),
  /** When the last of them merged; null while one is open. */
  closedAt: Schema.NullOr(Schema.String),
});

export type ChunkFinalPrs = typeof ChunkFinalPrs.Type;

export const DriveRecord = Schema.Struct({
  startedAt: Schema.String,
  endedAt: Schema.String,
  wallMs: Schema.Finite,
  stop: Schema.String,
  piTurns: Schema.Array(PiTurn),
  humanTurns: Schema.Array(HumanTurn),
  humanMerges: Schema.Array(HumanMerge),
  rootSession: Schema.NullOr(Schema.String),
  /** Absent in records from before the chunk scope. */
  chunkFinalPrs: Schema.optionalKey(ChunkFinalPrs),
});

export type DriveRecord = typeof DriveRecord.Type;

const MERGE_POLL_MS = 10_000;

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const AssistantLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Unknown),
  }),
});

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(AssistantLine));

const isText = Schema.is(TextPart);

/** The text of every assistant message in a session file, in order. */
export function assistantTexts(jsonl: string): string[] {
  return jsonl.split("\n").flatMap((line) => {
    const decoded = decodeLine(line);

    if (Option.isNone(decoded)) return [];

    const text = decoded.value.message.content
      .flatMap((part) => (isText(part) ? [part.text] : []))
      .join("\n");

    return text === "" ? [] : [text];
  });
}

/** Every plan.md in the run's state folder, joined: the orchestrator's partition into final PRs. */
export function planText(stateDir: string): string {
  const root = join(stateDir, "pi-agent");

  if (!existsSync(root)) return "";

  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "plan.md")
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

interface PrSummary {
  readonly number: number;
  readonly headRefName: string;
}

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The PRs into `main` the plan names, by number or head branch; every one when it names none. */
export function chunkFinalPrs(
  prs: readonly PrSummary[],
  plan: string,
): { readonly numbers: number[]; readonly source: ChunkFinalPrs["source"] } {
  const named = prs.filter(
    (pr) =>
      new RegExp(`(?:#|/pull/)${pr.number}\\b`).test(plan) ||
      new RegExp(`(?<![\\w/.-])${escape(pr.headRefName)}(?![\\w/-])`).test(plan),
  );

  return named.length > 0
    ? { numbers: named.map((pr) => pr.number), source: "plan.md" }
    : { numbers: prs.map((pr) => pr.number), source: "every PR into main" };
}

/** Tracks the chunk's final PRs until they have all merged, then holds them fixed. */
export class ChunkScope {
  #frozen: ChunkFinalPrs | null = null;
  readonly #ghState: string;
  readonly #stateDir: string;

  /** `ghState` is the fake GitHub's state file; `stateDir` the run's `~/.local/state`. */
  constructor({ ghState, stateDir }: { ghState: string; stateDir: string }) {
    this.#ghState = ghState;
    this.#stateDir = stateDir;
  }

  /** The chunk's final PRs now, open and merged; freezes them once every one has merged. */
  observe() {
    const state = readGitHub(this.#ghState);
    const intoMain = state.prs.filter((pr) => pr.baseRefName === state.defaultBranch);
    const scope = this.#frozen ?? chunkFinalPrs(intoMain, planText(this.#stateDir));
    const mine = intoMain.filter((pr) => scope.numbers.includes(pr.number));
    const open = mine.filter((pr) => pr.state === "OPEN").map((pr) => pr.number);
    const merged = mine.filter((pr) => pr.state === "MERGED").length;

    if (this.#frozen === null && open.length === 0 && merged > 0)
      this.#frozen = { ...scope, closedAt: new Date().toISOString() };

    const record: ChunkFinalPrs = this.#frozen ?? { ...scope, closedAt: null };

    return { open, merged, record };
  }

  get closed(): boolean {
    return this.#frozen !== null;
  }
}

class HumanMerger {
  readonly merges: HumanMerge[] = [];
  readonly #world: World;
  readonly #sessionDir: string;
  /** Claims already acted on, by PR number and the index of the message that made them. */
  readonly #handled = new Set<string>();

  constructor(world: World, sessionDir: string) {
    this.#world = world;
    this.#sessionDir = sessionDir;
  }

  /**
   * Merges every open final PR a root message has called merge-ready, until the chunk closed.
   * Returns those merged now.
   */
  sweep(scope: ChunkScope): number[] {
    const session = sessionFile(this.#sessionDir);

    if (session === undefined || scope.closed) return [];

    const texts = assistantTexts(readFileSync(session, "utf8"));
    const state = readGitHub(this.#world.gh.state);

    const open = new Set(
      state.prs
        .filter((pr) => pr.baseRefName === state.defaultBranch && pr.state === "OPEN")
        .map((pr) => pr.number),
    );

    const merged: number[] = [];

    texts.forEach((text, index) => {
      for (const { pr, sentence } of mergeReadyClaims(text)) {
        const key = `${pr}@${index}`;

        if (!open.has(pr) || this.#handled.has(key)) continue;

        this.#handled.add(key);

        const result = call(
          this.#world.gh,
          this.#world.tracker,
          ["pr", "merge", String(pr), "--merge"],
          "human",
        );

        const ok = result.exitCode === 0;

        this.merges.push({
          at: new Date().toISOString(),
          pr,
          ok,
          claim: sentence,
          detail: (ok ? result.stdout : result.stderr).trim().slice(0, 500),
        });

        if (ok) {
          merged.push(pr);
          open.delete(pr);
        }
      }
    });

    return merged;
  }
}

/** The orchestrator already knows of a merge its last text reports, as its watcher told it. */
export function acknowledgesMerge(text: string, pr: number): boolean {
  return new RegExp(`#${pr}\\b[^\\n]*\\bmerged\\b|\\bmerged\\b[^\\n]*#${pr}\\b`, "i").test(text);
}

/** What the run has cost so far: the root session plus every child session in the run's home. */
export function runCost(world: World, sessionDir: string): number {
  return [...sessionFiles(sessionDir), ...sessionFiles(world.home.sessions)].reduce(
    (sum, file) => sum + sessionCost(file),
    0,
  );
}

function lastText(sessionDir: string): string {
  const session = sessionFile(sessionDir);

  if (session === undefined) return "";

  return assistantTexts(readFileSync(session, "utf8")).at(-1) ?? "";
}

export async function drive(
  world: World,
  settings: DriveSettings,
  outDir: string,
): Promise<DriveRecord> {
  const started = Date.now();
  const deadline = started + settings.timeoutMs;
  const sessionDir = join(world.scratch, "root-session");
  const merger = new HumanMerger(world, sessionDir);
  const scope = new ChunkScope({ ghState: world.gh.state, stateDir: world.home.state });
  const piTurns: PiResult[] = [];
  const durations: number[] = [];
  const humanTurns: (typeof HumanTurn.Type)[] = [];
  const sheet = { owner: OWNER, repo: world.name, port: world.deploy.port };
  const pendingMerges: number[] = [];
  let intakeAnswered = false;
  let beyondChunkDeclined = false;

  mkdirSync(sessionDir, { recursive: true });

  let overBudget = false;

  const poll = setInterval(() => {
    pendingMerges.push(...merger.sweep(scope));
    scope.observe();

    if (runCost(world, sessionDir) <= settings.maxCostUsd) return;

    // Every process of the run carries its HOME, so this stops the root and every child.
    overBudget = true;
    killProcessesWithEnv("HOME", world.home.home);
  }, MERGE_POLL_MS);

  // Each turn resumes the session the previous turn wrote, so turns run one after another.
  const play = async (turn: number, reply: string): Promise<string> => {
    const remaining = deadline - Date.now();

    if (remaining <= 0) return "wall cap";

    const session = sessionFile(sessionDir);
    const resume = session === undefined ? [] : ["--session", session];
    const logDir = join(outDir, "turns", String(turn));

    mkdirSync(logDir, { recursive: true });

    const turnStarted = Date.now();

    const result = await runPi(
      world.workdir,
      [
        "-p",
        "--model",
        settings.model,
        "--thinking",
        settings.thinking,
        "--session-dir",
        sessionDir,
        ...resume,
        reply,
      ],
      logDir,
      remaining,
      world.env,
    );

    piTurns.push(result);
    durations.push(Date.now() - turnStarted);
    pendingMerges.push(...merger.sweep(scope));

    if (overBudget) return "cost cap";

    if (result.timedOut) return "wall cap";

    const prs = scope.observe();
    const text = lastText(sessionDir);

    const decision = decide({
      text,
      intakeAnswered,
      mergedNow: pendingMerges.filter((pr) => !acknowledgesMerge(text, pr)),
      openFinalPrs: prs.open.length,
      mergedFinalPrs: prs.merged,
      beyondChunkDeclined,
      sheet,
    });

    pendingMerges.length = 0;

    if (decision.kind === "stop") return decision.why;

    if (turn === settings.maxTurns) return "turn cap";

    if (decision.reason === "intake") intakeAnswered = true;

    if (decision.reason === "beyond-chunk") beyondChunkDeclined = true;

    humanTurns.push({
      at: new Date().toISOString(),
      reason: decision.reason satisfies Reason,
      answering: text.slice(-1500),
      reply: decision.text,
    });

    return play(turn + 1, decision.text);
  };

  let stop: string;

  try {
    stop = await play(0, settings.prompt);
  } finally {
    clearInterval(poll);
  }

  const session = sessionFile(sessionDir);
  const rootCopy = join(outDir, "root.jsonl");

  if (session !== undefined && existsSync(session)) copyFileSync(session, rootCopy);

  const record: DriveRecord = {
    startedAt: new Date(started).toISOString(),
    endedAt: new Date().toISOString(),
    wallMs: Date.now() - started,
    stop,
    piTurns: piTurns.map((result, index) => ({
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: durations[index] ?? 0,
    })),
    humanTurns,
    humanMerges: merger.merges,
    rootSession: session === undefined ? null : rootCopy,
    chunkFinalPrs: scope.observe().record,
  };

  writeAtomically(join(outDir, "drive.json"), `${JSON.stringify(record, null, 2)}\n`);

  return record;
}
