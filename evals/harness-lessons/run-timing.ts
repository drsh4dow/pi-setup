// The time and money a run's own turn spent, read from its raw session: what each assistant
// message cost, when its first tool call went out, and when each shell command started and ended.
// A bash call ends when its result comes back; a background terminal ends when its results
// message reports its elapsed time. A command inside a codemode script gets the script's times.

import { Option, Schema } from "effect";
import { argument } from "../lib/session.ts";

const ToolCall = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});

const Assistant = Schema.Struct({
  type: Schema.Literal("message"),
  timestamp: Schema.String,
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Unknown),
    usage: Schema.optionalKey(
      Schema.Struct({ cost: Schema.optionalKey(Schema.Struct({ total: Schema.Finite })) }),
    ),
  }),
});

const ToolResult = Schema.Struct({
  type: Schema.Literal("message"),
  timestamp: Schema.String,
  message: Schema.Struct({
    role: Schema.Literal("toolResult"),
    toolCallId: Schema.String,
    details: Schema.optionalKey(Schema.Unknown),
  }),
});

const TerminalResults = Schema.Struct({
  type: Schema.Literal("custom_message"),
  customType: Schema.Literal("background-terminal-results"),
  details: Schema.Struct({
    terminals: Schema.Array(Schema.Struct({ id: Schema.String, elapsedMs: Schema.Finite })),
  }),
});

const Line = Schema.Union([Assistant, ToolResult, TerminalResults]);

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line));

const decodeToolCall = Schema.decodeUnknownOption(ToolCall);

const decodeTerminalId = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }));

const decodeNested = Schema.decodeUnknownOption(
  Schema.Struct({
    calls: Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.String })),
  }),
);

export interface TimedCommand {
  readonly tool: "bash" | "bg_start";
  readonly command: string;
  readonly startMs: number;
  /** Absent for a background terminal the session never saw end. */
  readonly endMs: number | undefined;
  /** Run from a codemode script, which records no times of its own calls. */
  readonly nested: boolean;
}

export interface RunTiming {
  readonly kind: "timing";
  /** The sum of the assistant messages' reported cost, in US dollars. */
  readonly costUsd: number;
  readonly firstCallMs: number | undefined;
  readonly lastEntryMs: number | undefined;
  readonly commands: readonly TimedCommand[];
}

interface Issued {
  readonly name: string;
  readonly argumentsJson: string;
  readonly startMs: number;
}

const commandOf = (tool: string, argumentsJson: string) =>
  argument(
    {
      step: 0,
      tool,
      argumentsJson,
      succeeded: true,
      nested: false,
      calledAt: undefined,
      output: "",
    },
    "command",
  );

const isShell = (name: string): name is "bash" | "bg_start" =>
  name === "bash" || name === "bg_start";

export function runTiming(jsonl: string): RunTiming {
  const issued = new Map<string, Issued>();
  const commands: TimedCommand[] = [];
  const terminals = new Map<string, number>();
  let costUsd = 0;
  let firstCallMs: number | undefined;
  let lastEntryMs: number | undefined;

  for (const raw of jsonl.split("\n")) {
    if (raw.trim() === "") continue;

    const decoded = decodeLine(raw);

    if (Option.isNone(decoded)) continue;

    const line = decoded.value;

    if (line.type === "custom_message") {
      for (const terminal of line.details.terminals) {
        const index = terminals.get(terminal.id);

        if (index === undefined) continue;

        const started = commands[index];

        if (started !== undefined)
          commands[index] = { ...started, endMs: started.startMs + terminal.elapsedMs };
      }

      continue;
    }

    const at = Date.parse(line.timestamp);

    lastEntryMs = at;

    if (line.message.role === "assistant") {
      costUsd += line.message.usage?.cost?.total ?? 0;

      for (const part of line.message.content) {
        const call = decodeToolCall(part);

        if (Option.isNone(call)) continue;

        firstCallMs ??= at;
        issued.set(call.value.id, {
          name: call.value.name,
          argumentsJson: JSON.stringify(call.value.arguments),
          startMs: at,
        });
      }

      continue;
    }

    const call = issued.get(line.message.toolCallId);

    if (call === undefined) continue;

    if (call.name === "codemode") {
      const nested = decodeNested(line.message.details);

      for (const inner of Option.isSome(nested) ? nested.value.calls : []) {
        const command = commandOf(inner.name, inner.args);

        if (isShell(inner.name) && command !== undefined)
          commands.push({
            tool: inner.name,
            command,
            startMs: call.startMs,
            endMs: at,
            nested: true,
          });
      }

      continue;
    }

    const command = commandOf(call.name, call.argumentsJson);

    if (!isShell(call.name) || command === undefined) continue;

    if (call.name === "bg_start") {
      const terminal = decodeTerminalId(line.message.details);

      if (Option.isSome(terminal)) terminals.set(terminal.value.id, commands.length);

      commands.push({
        tool: "bg_start",
        command,
        startMs: call.startMs,
        endMs: undefined,
        nested: false,
      });
    } else {
      commands.push({ tool: "bash", command, startMs: call.startMs, endMs: at, nested: false });
    }
  }

  return { kind: "timing", costUsd, firstCallMs, lastEntryMs, commands };
}

export type RenderKind = "draft" | "final";

const MANIM = /\bmanim\s+(?:render\s+)?(?:-\S+\s+)*[^\s;&|]+\.py\b/;

const TOOLKIT = /(?:video\.ts|catchup-video)\b[^\n;&|]*?\s(draft|render|final)\b/;

const DRAFT = /\bdraft\b|\s-q\s*[lm]\b|--quality[= ]?[lm]\b|\b(?:480|720)p/;

/** Whether a shell command renders a video, and at which quality, as far as its text shows. */
export function renderKind(command: string): RenderKind | undefined {
  if (!MANIM.test(command) && !TOOLKIT.test(command)) return undefined;

  return DRAFT.test(command) ? "draft" : "final";
}
