// Reads a Pi session file into the tool operations a run performed, in execution order, with
// codemode scripts expanded into the calls they made. Graders build their metrics on this view.

import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
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
  id: Schema.optionalKey(Schema.String),
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
    nestedCalls: Schema.optionalKey(Schema.Unknown),
  }),
});

type ToolResultMessage = typeof ToolResultLine.Type.message;

const OtherLine = Schema.Struct({ type: Schema.String });

const decodeSessionLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([AssistantLine, ToolResultLine, OtherLine])),
);

// Codemode records each tool call its script made. It truncates long argument JSON, so the
// arguments stay a string: a path or command sits near the start, where truncation cannot reach it.
// A script that failed before it ran, such as one with a misplaced `// @options:` line, records no
// calls.
const TruncatedCall = Schema.Struct({
  name: Schema.String,
  args: Schema.String,
  status: Schema.String,
});

const decodeCodemodeDetails = Schema.decodeUnknownSync(
  Schema.Struct({ calls: Schema.optionalKey(Schema.Array(TruncatedCall)) }),
);

// Newer codemode results also record each nested call untruncated in `nestedCalls`, in the same
// order as `details.calls`. Pi's record keeps at most 256 calls and marks itself incomplete when
// it drops any, so the calls past its end are the truncated ones `details` holds. A call whose
// arguments were too large records only their size, so its arguments are the truncated ones
// `details` holds at the same position.
const FullCall = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const decodeNestedCalls = Schema.decodeUnknownOption(
  Schema.Struct({ calls: Schema.Array(FullCall), complete: Schema.optionalKey(Schema.Boolean) }),
);

interface NestedCall {
  readonly name: string;
  readonly argumentsJson: string;
  readonly status: string;
}

function nestedCallsOf(result: ToolResultMessage): readonly NestedCall[] {
  const { details, nestedCalls } = result;

  // A script that failed before calling any tool records no details.
  const truncatedCalls = () =>
    details === undefined || details === null ? [] : (decodeCodemodeDetails(details).calls ?? []);

  const full = decodeNestedCalls(nestedCalls);

  if (Option.isNone(full)) {
    return truncatedCalls().map((call) => ({
      name: call.name,
      argumentsJson: call.args,
      status: call.status,
    }));
  }

  const { calls, complete } = full.value;

  const truncated =
    complete === false || calls.some((call) => call.arguments === undefined)
      ? truncatedCalls()
      : [];

  return [
    ...calls.map((call, index) => ({
      name: call.name,
      argumentsJson: fullOrTruncated(call, truncated[index]),
      status: call.status,
    })),
    ...truncated.slice(calls.length).map((call) => ({
      name: call.name,
      argumentsJson: call.args,
      status: call.status,
    })),
  ];
}

/** A nested call's arguments: in full, else the truncated ones recorded for the same call. */
function fullOrTruncated(
  call: typeof FullCall.Type,
  truncated: typeof TruncatedCall.Type | undefined,
): string {
  if (call.arguments !== undefined) return JSON.stringify(call.arguments);

  return truncated?.args ?? "{}";
}

export interface ToolOperation {
  /** Position in execution order, counting codemode's nested calls. */
  readonly step: number;
  /** The id of the assistant entry that issued the call, or of the codemode call that made it. */
  readonly entryId?: string;
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
  readonly entryId: string | undefined;
}

const MessageContent = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([TextPart, OtherPart])),
]);

/** A message's text, whether its content is one string or a list of parts. */
function contentText(content: typeof MessageContent.Type): string {
  return Schema.is(Schema.String)(content) ? content : textOf(content);
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
        if (Schema.is(ToolCallPart)(part)) {
          calls.set(part.id, { part, calledAt: line.timestamp, entryId: line.id });
        }
      }

      continue;
    }

    if (!Schema.is(ToolResultLine)(line)) continue;

    const call = calls.get(line.message.toolCallId);

    if (!call) continue;

    if (call.part.name !== "codemode") {
      result.push({
        step: result.length,
        entryId: call.entryId,
        tool: call.part.name,
        argumentsJson: JSON.stringify(call.part.arguments),
        succeeded: line.message.isError !== true,
        nested: false,
        calledAt: call.calledAt,
        output: textOf(line.message.content ?? []),
      });

      continue;
    }

    for (const nested of nestedCallsOf(line.message)) {
      result.push({
        step: result.length,
        entryId: call.entryId,
        tool: nested.name,
        argumentsJson: nested.argumentsJson,
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

const UserTextLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({
    role: Schema.Literal("user"),
    content: MessageContent,
  }),
});

const decodeUserTextLine = Schema.decodeUnknownOption(Schema.fromJsonString(UserTextLine));

/** The text of the session's first user message, such as an expanded prompt template. */
export function firstUserText(jsonl: string): string | undefined {
  for (const line of jsonl.split("\n")) {
    const decoded = decodeUserTextLine(line);

    if (Option.isNone(decoded)) continue;

    const { content } = decoded.value.message;

    return contentText(content);
  }

  return undefined;
}

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

const SystemLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({
    role: Schema.Literal("system"),
    sections: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  }),
});

const RoleLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({ role: Schema.String }),
});

const decodeRoleLine = Schema.decodeUnknownOption(Schema.fromJsonString(RoleLine));

const decodeSystemLine = Schema.decodeUnknownOption(Schema.fromJsonString(SystemLine));

/**
 * The system prompt's sections the session's first request ran with, such as `preamble` and
 * `skills`: its system messages replayed in order up to the first assistant message, each patching
 * sections by name, with `null` removing one. A session older than system messages declares its
 * prompt after the first user message, still before the first reply.
 */
export function promptSections(jsonl: string): Readonly<Record<string, string>> {
  const sections = new Map<string, string>();

  for (const line of jsonl.split("\n")) {
    const role = decodeRoleLine(line);

    if (Option.isNone(role)) continue;

    if (role.value.message.role === "assistant") break;

    const system = decodeSystemLine(line);

    if (Option.isNone(system)) continue;

    for (const [name, text] of Object.entries(system.value.message.sections ?? {})) {
      if (text === null) sections.delete(name);
      else sections.set(name, text);
    }
  }

  return Object.fromEntries(sections);
}

/** An extension's entry that never enters the model's context, such as the `sh4dow-mode` marker. */
export interface CustomEntry {
  readonly id: string;
  readonly customType: string;
  readonly data: unknown;
}

const CustomLine = Schema.Struct({
  type: Schema.Literal("custom"),
  id: Schema.String,
  customType: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});

const decodeCustomLine = Schema.decodeUnknownOption(Schema.fromJsonString(CustomLine));

export function customEntries(jsonl: string): readonly CustomEntry[] {
  return jsonl.split("\n").flatMap((line) => {
    const entry = decodeCustomLine(line);

    return Option.isSome(entry)
      ? [{ id: entry.value.id, customType: entry.value.customType, data: entry.value.data }]
      : [];
  });
}

/** An extension's message that enters the model's context, such as background terminal results. */
export interface CustomMessage {
  readonly id: string;
  readonly customType: string;
  readonly text: string;
  readonly details: unknown;
}

const CustomMessageLine = Schema.Struct({
  type: Schema.Literal("custom_message"),
  id: Schema.String,
  customType: Schema.String,
  content: MessageContent,
  details: Schema.optionalKey(Schema.Unknown),
});

const decodeCustomMessageLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(CustomMessageLine),
);

export function customMessages(jsonl: string): readonly CustomMessage[] {
  return jsonl.split("\n").flatMap((line) => {
    const entry = decodeCustomMessageLine(line);

    if (Option.isNone(entry)) return [];

    const { id, customType, content, details } = entry.value;

    return [{ id, customType, text: contentText(content), details }];
  });
}

// Small, so a head read takes at most this much of the body past the first user message.
const HEAD_CHUNK_BYTES = 4 * 1024;

/**
 * The session file's lines up to and including its first user message, read in 4 KiB chunks
 * that stop at the chunk holding its end, so at most one chunk of the rest is ever read. A file
 * with no user message is read whole.
 */
export function sessionHead(path: string): string {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.alloc(HEAD_CHUNK_BYTES);
  // Keeps a character whose bytes straddle two reads whole.
  const decoder = new StringDecoder("utf8");
  const kept: string[] = [];
  let pending = "";

  try {
    for (;;) {
      const read = readSync(descriptor, buffer, 0, HEAD_CHUNK_BYTES, null);
      const done = read === 0;

      pending += done ? decoder.end() : decoder.write(buffer.subarray(0, read));

      const complete = pending.split("\n");

      pending = done ? "" : (complete.pop() ?? "");

      for (const line of complete) {
        if (line.trim() === "") continue;

        kept.push(line);

        if (Option.isSome(decodeUserLine(line))) return kept.join("\n");
      }

      if (done) return kept.join("\n");
    }
  } finally {
    closeSync(descriptor);
  }
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
