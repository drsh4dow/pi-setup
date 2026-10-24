// Arm isolation, read from the sessions a run left: every Pi of the run, the root and each child
// `pi-subagent` started, must have run with the arm's harness. Pi records each session's system
// prompt in sections; the preamble is SYSTEM.md, `skills` lists each skill's location, and
// `addendum` holds the files passed with --append-system-prompt.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Option, Schema } from "effect";

const SystemLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({
    role: Schema.Literal("system"),
    sections: Schema.Record(Schema.String, Schema.String),
  }),
});

const InfoLine = Schema.Struct({
  type: Schema.Literal("session_info"),
  name: Schema.optionalKey(Schema.String),
});

const decodeSystem = Schema.decodeUnknownOption(Schema.fromJsonString(SystemLine));

const decodeInfo = Schema.decodeUnknownOption(Schema.fromJsonString(InfoLine));

export interface HarnessExpectation {
  /** The arm's SYSTEM.md. */
  readonly systemPrompt: string;
  /** The run's `~/.pi/agent`, where skill locations must point. */
  readonly runAgentDir: string;
  /** The live `~/.pi/agent`, which no session of the run may load from. */
  readonly liveAgentDir: string;
  /** The subagent appendix files whose live text differs from the arm's. */
  readonly differingAppendices: readonly AppendixPair[];
  /** Text only the arm carries, required in every session when set (the isolation probe's marker). */
  readonly marker: string | null;
}

export interface SessionHarness {
  readonly file: string;
  readonly name: string | null;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** The files of a session directory tree, recursively. */
export function sessionFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();
}

function firstMatch<T>(
  lines: readonly string[],
  decode: (line: string) => Option.Option<T>,
): T | undefined {
  for (const line of lines) {
    const decoded = decode(line);

    if (Option.isSome(decoded)) return decoded.value;
  }

  return undefined;
}

const LOCATION = /<location>([^<]+)<\/location>/g;

export function checkSession(file: string, expected: HarnessExpectation): SessionHarness {
  const lines = readFileSync(file, "utf8").split("\n");
  const name = firstMatch(lines, decodeInfo)?.name ?? null;
  const system = firstMatch(lines, decodeSystem);

  if (system === undefined)
    return { file, name, ok: false, problems: ["no system prompt recorded"] };

  const { sections } = system.message;
  const all = Object.values(sections).join("\n");
  const problems: string[] = [];

  if ((sections.preamble ?? "").trim() !== expected.systemPrompt.trim()) {
    problems.push("the system prompt is not the arm's SYSTEM.md");
  }

  const locations = [...(sections.skills ?? "").matchAll(LOCATION)].map((match) => match[1]);

  const foreign = locations.filter(
    (location) => !location.startsWith(`${expected.runAgentDir}/skills/`),
  );

  if (locations.length === 0) problems.push("no skills listed");

  if (foreign.length > 0)
    problems.push(
      `skills load from outside the run's agent dir: ${foreign.slice(0, 3).join(", ")}`,
    );

  if (all.includes(`${expected.liveAgentDir}/`))
    problems.push(`the system prompt names the live agent dir ${expected.liveAgentDir}`);

  const addendum = sections.addendum ?? "";

  const leaked = expected.differingAppendices.filter(
    (pair) => addendum.includes(pair.live.trim()) && !addendum.includes(pair.arm.trim()),
  );

  if (leaked.length > 0)
    problems.push("the addendum carries the live harness's version of an appendix");

  if (expected.marker !== null && !all.includes(expected.marker))
    problems.push(`the arm's marker ${expected.marker} is missing`);

  return { file, name, ok: problems.length === 0, problems };
}

export interface AppendixPair {
  readonly name: string;
  readonly live: string;
  /** Empty when the arm dropped the file. */
  readonly arm: string;
}

/**
 * The live harness's subagent appendices whose text differs from the arm's copy. A session whose
 * addendum holds the live text and not the arm's loaded the live harness.
 */
export function differingAppendices({
  liveSubagents,
  armSubagents,
}: {
  liveSubagents: string;
  armSubagents: string;
}): AppendixPair[] {
  return readdirSync(liveSubagents)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => {
      const live = readFileSync(join(liveSubagents, name), "utf8");
      let arm = "";

      try {
        arm = readFileSync(join(armSubagents, name), "utf8");
      } catch {
        // The arm dropped the file, so any trace of it is live text.
      }

      return live.trim() === arm.trim() ? [] : [{ name, live, arm }];
    });
}
