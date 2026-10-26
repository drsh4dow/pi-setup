import { Schema } from "effect";

// The kind files the subagents skill appends, and the argv of each kind of Pi session.

export const UNATTENDED = "/h/.pi/agent/skills/subagents/unattended.md";

export const OWNER = "/h/.pi/agent/skills/subagents/owner.md";

export const DELEGATE = "/h/.pi/agent/skills/subagents/delegate.md";

export const rootArgv = ["node", "pi"];

export const delegateArgv = [
  "node",
  "pi",
  "--print",
  "--append-system-prompt",
  UNATTENDED,
  "--append-system-prompt",
  DELEGATE,
];

export const ownerArgv = [
  "node",
  "pi",
  "--print",
  "--append-system-prompt",
  UNATTENDED,
  "--append-system-prompt",
  OWNER,
];

// A `tool_call` handler blocks with `{ block: true, reason }` and lets a call run with `undefined`.
export const Refusal = Schema.Struct({ block: Schema.Literal(true), reason: Schema.String });

export type Refusal = typeof Refusal.Type;

export const decodeDecision = Schema.decodeUnknownSync(Schema.UndefinedOr(Refusal));
