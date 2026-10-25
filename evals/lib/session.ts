// Reads a Pi session file into the tool operations a run performed, in execution order, with
// codemode scripts expanded into the calls they made. Graders build their metrics on this view.

import { Option, Schema } from "effect";

const ToolCallPart = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const OtherPart = Schema.Struct({ type: Schema.String });

const AssistantLine = Schema.Struct({
  type: Schema.Literal("message"),
  timestamp: Schema.optionalKey(Schema.String),
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Union([ToolCallPart, TextPart, OtherPart])),
    stopReason: Schema.optionalKey(Schema.String),
  }),
});

const ToolResultLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({
    role: Schema.Literal("toolResult"),
    toolCallId: Schema.String,
    isError: Schema.optionalKey(Schema.Boolean),
    content: Schema.optionalKey(Schema.Array(Schema.Union([TextPart, OtherPart]))),
    details: Schema.optionalKey(Schema.Unknown),
  }),
});

const OtherLine = Schema.Struct({ type: Schema.String });

const decodeSessionLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([AssistantLine, ToolResultLine, OtherLine])),
);

// Codemode records each tool call its script made. It truncates long argument JSON, so the
// arguments stay a string: a path or command sits near the start, where truncation cannot reach it.
// A script that failed before it ran, such as one with a misplaced `// @options:` line, records no
// calls.
const decodeCodemodeDetails = Schema.decodeUnknownSync(
  Schema.Struct({
    calls: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({ name: Schema.String, args: Schema.String, status: Schema.String }),
      ),
    ),
  }),
);

export interface ToolOperation {
  /** Position in execution order, counting codemode's nested calls. */
  readonly step: number;
  readonly tool: string;
  /** The call's arguments as JSON text. Codemode truncates long nested arguments, so it may not parse. */
  readonly argumentsJson: string;
  readonly succeeded: boolean;
  /** Made from inside a codemode script. */
  readonly nested: boolean;
  /** When the model issued the call, absent in sessions that record no timestamps. */
  readonly calledAt: string | undefined;
  /** The tool's text output. Nested codemode calls record none, so theirs is empty. */
  readonly output: string;
}

export interface Session {
  readonly operations: readonly ToolOperation[];
  readonly lastStopReason: string | undefined;
  /** The text of the last assistant message that has any. */
  readonly finalText: string;
  /** The text of each assistant message that ended a turn, in order. */
  readonly turnEndTexts: readonly string[];
}

type SessionLine = ReturnType<typeof decodeSessionLine>;

interface IssuedCall {
  readonly part: typeof ToolCallPart.Type;
  readonly calledAt: string | undefined;
}

function textOf(parts: readonly (typeof TextPart.Type | typeof OtherPart.Type)[]): string {
  return parts.flatMap((part) => (Schema.is(TextPart)(part) ? [part.text] : [])).join("\n");
}

function toolOperations(lines: readonly SessionLine[]): ToolOperation[] {
  const calls = new Map<string, IssuedCall>();
  const result: ToolOperation[] = [];

  for (const line of lines) {
    if (Schema.is(AssistantLine)(line)) {
      for (const part of line.message.content) {
        if (Schema.is(ToolCallPart)(part)) calls.set(part.id, { part, calledAt: line.timestamp });
      }

      continue;
    }

    if (!Schema.is(ToolResultLine)(line)) continue;

    const call = calls.get(line.message.toolCallId);

    if (!call) continue;

    if (call.part.name !== "codemode") {
      result.push({
        step: result.length,
        tool: call.part.name,
        argumentsJson: JSON.stringify(call.part.arguments),
        succeeded: line.message.isError !== true,
        nested: false,
        calledAt: call.calledAt,
        output: textOf(line.message.content ?? []),
      });

      continue;
    }

    // A script that failed before calling any tool records no details.
    const details = line.message.details;

    const nestedCalls =
      details === undefined || details === null ? [] : (decodeCodemodeDetails(details).calls ?? []);

    for (const nested of nestedCalls) {
      result.push({
        step: result.length,
        tool: nested.name,
        argumentsJson: nested.args,
        succeeded: nested.status === "ok",
        nested: true,
        calledAt: call.calledAt,
        output: "",
      });
    }
  }

  return result;
}

const UserLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({ role: Schema.Literal("user") }),
});

const decodeUserLine = Schema.decodeUnknownOption(Schema.fromJsonString(UserLine));

/**
 * The session from its last user message on: the turn a `pi -p` run added to a session it
 * continued, without the chat it was seeded with.
 */
export function sinceLastUserMessage(jsonl: string): string {
  const lines = jsonl.split("\n").filter((line) => line.trim() !== "");
  const last = lines.findLastIndex((line) => Option.isSome(decodeUserLine(line)));

  return lines.slice(Math.max(last, 0)).join("\n");
}

export function parseSession(jsonl: string): Session {
  const lines = jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => decodeSessionLine(line));

  const assistant = lines.filter((line) => Schema.is(AssistantLine)(line));
  const texts = assistant.map((line) => textOf(line.message.content));

  return {
    operations: toolOperations(lines),
    lastStopReason: assistant.findLast((line) => line.message.stopReason !== undefined)?.message
      .stopReason,
    finalText: texts.findLast((text) => text !== "") ?? "",
    turnEndTexts: assistant.flatMap((line, index) =>
      line.message.stopReason === "stop" && texts[index] !== "" ? [texts[index]] : [],
    ),
  };
}

const decodeArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const asString = Schema.decodeUnknownOption(Schema.String);

/**
 * A string argument of the call, such as a bash `command` or a read `path`. Truncated codemode
 * arguments still yield the part of the string recorded before the cut.
 */
export function argument(operation: ToolOperation, key: string): string | undefined {
  const parsed = decodeArguments(operation.argumentsJson);

  if (Option.isSome(parsed)) return Option.getOrUndefined(asString(parsed.value[key]));

  const escaped = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)`).exec(operation.argumentsJson)?.[1];

  if (escaped === undefined) return undefined;

  // A cut can split an escape sequence; drop the dangling backslash before decoding.
  return decodeJsonString(escaped.replace(/\\[^"\\/bfnrtu]?$|\\u[0-9a-fA-F]{0,3}$/, ""));
}

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

function decodeJsonString(escaped: string): string | undefined {
  const decoded = decodeJsonText(`"${escaped}"`);

  return Option.getOrUndefined(decoded);
}

export type LoadChannel = "read" | "codemode read" | "bash";

export interface SkillLoad {
  /** The skill's directory name. */
  readonly skill: string;
  readonly step: number;
  readonly channel: LoadChannel;
}

const SKILL_FILE = /skills\/([a-z0-9-]+)\/SKILL\.md/g;

// A bash command counts as a load only when it prints the file, not when it lists or greps it.
const BASH_FILE_PRINTER = /\b(cat|head|sed|bat|less)\b/;

/** The text an operation exposes skill paths through: a read's path, or a printing bash command. */
function loadingText(operation: ToolOperation): string {
  if (!operation.succeeded) return "";

  if (operation.tool === "read") return argument(operation, "path") ?? "";

  const command = operation.tool === "bash" ? argument(operation, "command") : undefined;

  if (command !== undefined && BASH_FILE_PRINTER.test(command)) return command;

  return "";
}

function channelOf(operation: ToolOperation): LoadChannel {
  if (operation.tool === "bash") return "bash";

  return operation.nested ? "codemode read" : "read";
}

/**
 * The first successful load of each skill's `SKILL.md`, in load order: through `read`, a
 * codemode `tools.read`, or a bash command that prints the file.
 */
export function skillLoads(operations: readonly ToolOperation[]): SkillLoad[] {
  const loads: SkillLoad[] = [];

  for (const operation of operations) {
    for (const match of loadingText(operation).matchAll(SKILL_FILE)) {
      const skill = match[1];

      if (!loads.some((load) => load.skill === skill)) {
        loads.push({ skill, step: operation.step, channel: channelOf(operation) });
      }
    }
  }

  return loads;
}
