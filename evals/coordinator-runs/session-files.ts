// Finds the session files a grade reads and reads each one: the directory it ran in, and its
// entries, unless a line is no session entry.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { parseSession, type Session } from "../lib/session.ts";

const SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Every session file under `dir`, by the session id its name ends in. Opens none of them. */
export function sessionFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();

  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const id = SESSION_FILE.exec(entry.name)?.[1];

    if (entry.isFile() && id !== undefined) files.set(id, join(entry.parentPath, entry.name));
  }

  return files;
}

const decodeSessionHeader = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("session"), cwd: Schema.String })),
);

/** The directory a session ran in, from the header on its first line. */
export function sessionCwd(jsonl: string): string {
  const header = decodeSessionHeader(jsonl.split("\n", 1)[0]);

  return Option.isSome(header) ? header.value.cwd : "/";
}

/** What a session's head says about where it came from. */
export interface HeadFacts {
  /** When the session started, in milliseconds since the epoch, or NaN when its header says not. */
  readonly startedAt: number;
  /**
   * The session it continues: the one whose file its header's `parentSession` names, as Pi's
   * handoff writes it.
   */
  readonly continues: string | undefined;
  /** The name its head gives it, such as the `subagent: <name>` that launch.ts passes Pi. */
  readonly name: string | undefined;
}

const decodeHeadHeader = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("session"),
      timestamp: Schema.optionalKey(Schema.String),
      parentSession: Schema.optionalKey(Schema.String),
    }),
  ),
);

const decodeSessionInfo = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.Literal("session_info"), name: Schema.String }),
  ),
);

/** The facts `head`, a session file's lines up to its first user message, records. */
export function headFacts(head: string): HeadFacts {
  const [first = "", ...rest] = head.split("\n");
  const header = Option.getOrUndefined(decodeHeadHeader(first));
  const parent = header?.parentSession;

  const name = rest
    .map((line) => Option.getOrUndefined(decodeSessionInfo(line))?.name)
    .findLast((found) => found !== undefined);

  return {
    startedAt: Date.parse(header?.timestamp ?? ""),
    continues: parent === undefined ? undefined : SESSION_FILE.exec(parent)?.[1],
    name,
  };
}

/**
 * The session that `file` holds as `jsonl`, or none when one of its lines is no session entry,
 * such as a last line cut short while the session was still being written. The warning names the
 * file and line, never the line's text or the decode error, which can echo a recorded command
 * holding a credential.
 */
export function readSessionFile(
  file: string,
  jsonl: string,
  warn: (line: string) => void,
): Session | undefined {
  const session = readSession(jsonl);

  if (session === undefined) {
    const line = firstUnreadLine(jsonl);
    const at = line === undefined ? file : `${file}:${line}`;

    warn(`${at}: no session entry, so this session and the sessions it launched are not graded`);
  }

  return session;
}

/** The session `jsonl` records, or none when one of its lines is no session entry. */
function readSession(jsonl: string): Session | undefined {
  try {
    return parseSession(jsonl);
  } catch (error) {
    if (Schema.isSchemaError(error)) return undefined;

    throw error;
  }
}

/** The 1-based number of the first line of `jsonl` that is no session entry. */
function firstUnreadLine(jsonl: string): number | undefined {
  const index = jsonl
    .split("\n")
    .findIndex((line) => line.trim() !== "" && readSession(line) === undefined);

  return index === -1 ? undefined : index + 1;
}
