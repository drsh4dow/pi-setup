// The text of a Pi session, for a judge to check claims against: what each role wrote, one line
// per text part, without thinking or tool calls.

import { Option, Schema } from "effect";

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const Line = Schema.Struct({
  message: Schema.optional(
    Schema.Struct({
      role: Schema.String,
      content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
    }),
  ),
});

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line));

const isText = Schema.is(TextPart);

const isString = Schema.is(Schema.String);

/** Each text part `roles` wrote in `jsonl` from line `from` (0-based), as "role: text". */
export function chatRecord(
  jsonl: string,
  { from = 0, roles }: { readonly from?: number; readonly roles: readonly string[] },
): string[] {
  return jsonl
    .split("\n")
    .slice(from)
    .flatMap((line) => {
      const message = Option.getOrUndefined(decodeLine(line))?.message;

      if (message === undefined || !roles.includes(message.role)) return [];

      const parts = isString(message.content)
        ? [message.content]
        : message.content.filter(isText).map((part) => part.text);

      return parts.filter((text) => text.trim() !== "").map((text) => `${message.role}: ${text}`);
    });
}
