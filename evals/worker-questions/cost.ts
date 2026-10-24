// Dollars a Pi session spent, from its session file: every assistant message's usage plus the
// usage entries Pi records outside the conversation, such as compaction summaries.

import { Option, Schema } from "effect";

const Usage = Schema.Struct({ cost: Schema.Struct({ total: Schema.Finite }) });

const CostLine = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("message"),
    message: Schema.Struct({ role: Schema.Literal("assistant"), usage: Usage }),
  }),
  Schema.Struct({ type: Schema.Literals(["usage", "compaction", "branch_summary"]), usage: Usage }),
]);

const decodeCostLine = Schema.decodeUnknownOption(Schema.fromJsonString(CostLine));

export function sessionCost(jsonl: string): number {
  let total = 0;

  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;

    const parsed = decodeCostLine(line);

    if (Option.isNone(parsed)) continue;

    total +=
      parsed.value.type === "message"
        ? parsed.value.message.usage.cost.total
        : parsed.value.usage.cost.total;
  }

  return total;
}
