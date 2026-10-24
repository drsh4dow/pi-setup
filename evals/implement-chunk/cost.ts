// Model cost as the sessions record it: each assistant message carries its provider-reported
// usage, so a run's cost is the sum over the root session and every child session.

import { readFileSync } from "node:fs";
import { Option, Schema } from "effect";

const UsageLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    usage: Schema.Struct({ cost: Schema.Struct({ total: Schema.Finite }) }),
  }),
});

const decodeUsage = Schema.decodeUnknownOption(Schema.fromJsonString(UsageLine));

/** The USD cost a session file records, summed over its assistant messages. */
export function sessionCost(file: string): number {
  let total = 0;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    const usage = decodeUsage(line);

    if (Option.isSome(usage)) total += usage.value.message.usage.cost.total;
  }

  return total;
}
