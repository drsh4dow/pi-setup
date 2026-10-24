// The facts the grader reads from one Pi session file: its name, its first assignment, its last
// report, how many user messages it got (a resumed child gets more than one), and its cost.

import { readFileSync } from "node:fs";
import { Option, Schema } from "effect";
import { sessionCost } from "./cost.ts";

const Header = Schema.Struct({
  type: Schema.Literal("session"),
  timestamp: Schema.String,
  cwd: Schema.String,
});

const Info = Schema.Struct({
  type: Schema.Literal("session_info"),
  name: Schema.optionalKey(Schema.String),
});

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const MessageLine = Schema.Struct({
  type: Schema.Literal("message"),
  timestamp: Schema.optionalKey(Schema.String),
  message: Schema.Struct({
    role: Schema.String,
    content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  }),
});

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header));

const decodeInfo = Schema.decodeUnknownOption(Schema.fromJsonString(Info));

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(MessageLine));

const isText = Schema.is(TextPart);

export interface SessionFacts {
  readonly file: string;
  readonly startedAt: string;
  readonly cwd: string;
  readonly name: string;
  /** The first user message: the assignment, for a child. */
  readonly assignment: string;
  /** The last assistant text: the report, for a child. */
  readonly report: string;
  readonly userMessages: number;
  readonly costUsd: number;
}

function textOf(content: (typeof MessageLine.Type)["message"]["content"]): string {
  if (Schema.is(Schema.String)(content)) return content;

  return content.flatMap((part) => (isText(part) ? [part.text] : [])).join("\n");
}

export function readSessionFacts(file: string): SessionFacts {
  let startedAt = "";
  let cwd = "";
  let name = "";
  let assignment: string | undefined;
  let report = "";
  let userMessages = 0;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    const header = decodeHeader(line);

    if (Option.isSome(header)) {
      startedAt = header.value.timestamp;
      cwd = header.value.cwd;
      continue;
    }

    const info = decodeInfo(line);

    if (Option.isSome(info)) {
      name = info.value.name ?? name;
      continue;
    }

    const message = decodeMessage(line);

    if (Option.isNone(message)) continue;

    const text = textOf(message.value.message.content);

    if (message.value.message.role === "user") {
      userMessages += 1;
      assignment ??= text;
    }

    if (message.value.message.role === "assistant" && text !== "") report = text;
  }

  return {
    file,
    startedAt,
    cwd,
    name,
    assignment: assignment ?? "",
    report,
    userMessages,
    costUsd: sessionCost(file),
  };
}

export type Role =
  | "explorer"
  | "implementer"
  | "verifier"
  | "merger"
  | "pr-writer"
  | "babysitter"
  | "live-verifier"
  | "reviewer"
  | "other";

const ROLE_PATTERNS: readonly (readonly [Role, RegExp])[] = [
  ["live-verifier", /\blive[- ]verif/i],
  ["babysitter", /\bbabysit/i],
  [
    "pr-writer",
    /\bpr writer\b|\bfinal pr\b.*\b(open|write|edit)|\b(open|write|edit)\b.*\bfinal pr\b/i,
  ],
  ["merger", /\bmerger\b|\bmerge\b|\bintegration branch\b|\brebase\b|\bretarget/i],
  ["verifier", /\bverif|\bverdict\b/i],
  ["reviewer", /\breview\b|\bpersona\b|\blens\b/i],
  ["explorer", /\bexplor/i],
  ["implementer", /\bimplement|\bfix\b|\bTAL-\d+\b/i],
];

/** The role a child session played, read from its name first and its assignment second. */
export function roleOf(session: Pick<SessionFacts, "name" | "assignment">): Role {
  for (const text of [session.name, session.assignment.slice(0, 600)]) {
    for (const [role, pattern] of ROLE_PATTERNS) {
      if (pattern.test(text)) return role;
    }
  }

  return "other";
}
