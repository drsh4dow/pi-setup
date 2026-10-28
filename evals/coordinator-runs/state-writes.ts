// Links a units.tsv or ledger.tsv row to the coordinator tool call that wrote it last, judged by
// what each call wrote into the file: an edit or write of it, a chunk CLI call, or a shell
// statement that redirects into it or edits it in place.

import { homedir } from "node:os";
import { basename } from "node:path";
import { Option, Schema } from "effect";
import { argument, type ToolOperation } from "../lib/session.ts";
import { escapeRegExp, HEX, insideStateFolder, type TableRow } from "./chunk-state.ts";
import type { Chunk, GradedSession } from "./model.ts";
import { statements } from "./shell.ts";

/** Whether two SHAs, either abbreviated to seven or more characters, name one commit. */
const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

const namesAnySha = (text: string, sha: string) =>
  [...text.matchAll(HEX)].some((match) => sameSha(match[0], sha));

const decodeEdits = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      edits: Schema.Array(Schema.Struct({ oldText: Schema.String, newText: Schema.String })),
    }),
  ),
);

/** The text an `edit` replaced and put in, or the content a `write` wrote. */
function editedText(operation: ToolOperation): string {
  if (operation.tool === "write") return argument(operation, "content") ?? "";

  const edits = decodeEdits(operation.argumentsJson);

  const texts = Option.isSome(edits)
    ? edits.value.edits.flatMap((edit) => [edit.oldText, edit.newText])
    : [argument(operation, "oldText") ?? "", argument(operation, "newText") ?? ""];

  return texts.join("\n");
}

/** A state file and the chunk CLI verbs that write it. */
interface StateFile {
  readonly name: "units.tsv" | "ledger.tsv";
  readonly cli: RegExp;
}

const UNITS: StateFile = { name: "units.tsv", cli: /\bunit\s+(?:set|add)\s/ };

const LEDGER: StateFile = { name: "ledger.tsv", cli: /\bledger\s+(?:record|carry)\s/ };

/**
 * What the call wrote into the chunk's state file: the arguments of an `edit` or `write` of it,
 * or each bash statement that runs its chunk CLI verbs, redirects into it, or edits it in place,
 * with printf's `\t` and `\n` read as a tab and a newline. A name written in another statement
 * of the same command, such as a note appended to decisions.md, is not part of the write.
 */
function writesInto(operation: ToolOperation, chunk: Chunk, file: StateFile): string[] {
  if (!operation.succeeded) return [];

  if (operation.tool === "edit" || operation.tool === "write") {
    const path = argument(operation, "path")?.replace(/^~(?=\/)/, homedir());

    if (path === undefined || basename(path) !== file.name || !insideStateFolder(path, chunk.dir)) {
      return [];
    }

    return [editedText(operation)];
  }

  const command = operation.tool === "bash" ? argument(operation, "command") : undefined;

  if (command === undefined) return [];

  const name = escapeRegExp(file.name);

  const redirects = new RegExp(
    String.raw`(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?[^\s;|&'"]*${name}|\bsed\s+-i[^\n]*?${name}`,
  );

  return statements(command)
    .filter((statement) => file.cli.test(statement) || redirects.test(statement))
    .map((statement) => statement.replaceAll("\\t", "\t").replaceAll("\\n", "\n"));
}

/** Whether the call wrote the units.tsv row of unit `id`. */
export function writesUnit(chunk: Chunk, id: string) {
  const unit = escapeRegExp(id);
  const cli = new RegExp(String.raw`\bunit\s+(?:set|add)\s+["']?${unit}(?![\w./-])`);
  // The row as a line of the file, or as a printf or sed pattern opens it.
  const line = new RegExp(String.raw`(?:^|[\n'"^])${unit}\t`);

  return (operation: ToolOperation) =>
    writesInto(operation, chunk, UNITS).some((text) => cli.test(text) || line.test(text));
}

/** Whether the call wrote a ledger.tsv row at head `sha`. */
export function writesVerdict(chunk: Chunk, sha: string) {
  return (operation: ToolOperation) =>
    sha !== "" &&
    writesInto(operation, chunk, LEDGER).some((text) => {
      // `ledger record <pr> <sha> ...` and `ledger carry <pr> <new sha> <from sha>` write the
      // row at their second argument.
      const cli = /\bledger\s+(?:record|carry)\s+\S+\s+(\S+)/.exec(text)?.[1];

      return cli === undefined
        ? namesAnySha(text, sha)
        : /^[0-9a-f]{7,40}$/.test(cli) && sameSha(cli, sha);
    });
}

export const firstSha = (row: TableRow) => [...row.cell("head_sha").matchAll(HEX)][0]?.[0] ?? "";

/** A state-file row a finding comes from, and the coordinator entry that wrote it last. */
export interface StateRowLink {
  readonly session: string;
  /** The entry id, or `-` when no graded coordinator session holds a call that wrote the row. */
  readonly entry: string;
  /** `<state file>:<line>`. */
  readonly at: string;
}

export function rowLink(
  coordinators: readonly GradedSession[],
  file: string,
  row: TableRow,
  writes: (operation: ToolOperation) => boolean,
): StateRowLink {
  const at = `${file}:${row.line}`;
  let link: StateRowLink = { session: coordinators[0]?.id ?? "-", entry: "-", at };

  for (const session of coordinators) {
    const operation = session.operations.findLast(writes);

    if (operation?.entryId !== undefined) {
      link = { session: session.id, entry: operation.entryId, at };
    }
  }

  return link;
}
