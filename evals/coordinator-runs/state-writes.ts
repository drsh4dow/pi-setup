// Links a units.tsv or ledger.tsv row to the coordinator tool call that wrote it last, judged by
// what each call wrote into the file: an edit or write of it, a chunk CLI call, or a shell
// statement that redirects into it or edits it in place.

import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { Option, Schema } from "effect";
import { argument, type ToolOperation } from "../lib/session.ts";
import { escapeRegExp, HEX, insideStateFolder, type TableRow } from "./chunk-state.ts";
import type { Chunk, GradedSession } from "./model.ts";
import { shellStatements } from "./shell-writes.ts";

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
 * What the call, run from `cwd`, wrote into the chunk's state file: the arguments of an `edit`
 * or `write` of it, the arguments of each chunk CLI call whose state folder is the chunk's and
 * whose verb writes the file, or each bash statement that writes the file in the chunk's state
 * folder. Every `\t` and `\n` in a statement is read as a tab and a newline, as printf and sed
 * read them. A name written in another statement of the same command, such as a note appended to
 * decisions.md, is not part of the write.
 */
function writesInto(
  operation: ToolOperation,
  cwd: string,
  chunk: Chunk,
  file: StateFile,
): string[] {
  if (!operation.succeeded) return [];

  if (operation.tool === "edit" || operation.tool === "write") {
    const written = argument(operation, "path");

    if (written === undefined) return [];

    const path = resolve(cwd, written.replace(/^~(?=\/)/, homedir()));

    if (basename(path) !== file.name || !insideStateFolder(path, chunk.dir)) return [];

    return [editedText(operation)];
  }

  const command = operation.tool === "bash" ? argument(operation, "command") : undefined;

  if (command === undefined) return [];

  const isChunkFile = (path: string) =>
    basename(path) === file.name && insideStateFolder(path, chunk.dir);

  const texts: string[] = [];

  for (const statement of shellStatements(command, cwd)) {
    for (const call of statement.chunkCli) {
      if (
        call.state !== undefined &&
        insideStateFolder(call.state, chunk.dir) &&
        file.cli.test(`${call.args} `)
      ) {
        texts.push(call.args);
      }
    }

    if (statement.writes.some(isChunkFile)) {
      texts.push(statement.text.replaceAll("\\t", "\t").replaceAll("\\n", "\n"));
    }
  }

  return texts;
}

/** Whether the call wrote the units.tsv row of unit `id`. */
export function writesUnit(chunk: Chunk, id: string) {
  const unit = escapeRegExp(id);
  const cli = new RegExp(String.raw`\bunit\s+(?:set|add)\s+["']?${unit}(?![\w./-])`);
  // The row as a line of the file, or as a printf or sed pattern opens it.
  const line = new RegExp(String.raw`(?:^|[\n'"^])${unit}\t`);

  return (operation: ToolOperation, cwd: string) =>
    writesInto(operation, cwd, chunk, UNITS).some((text) => cli.test(text) || line.test(text));
}

/** Whether the call wrote a ledger.tsv row at head `sha`. */
export function writesVerdict(chunk: Chunk, sha: string) {
  return (operation: ToolOperation, cwd: string) =>
    sha !== "" &&
    writesInto(operation, cwd, chunk, LEDGER).some((text) => {
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

/**
 * The row's link to the latest coordinator call that wrote it, by the time the call was issued.
 * A call recorded with no time counts as earlier than any timed one; among calls with no time,
 * or the same time, the later session file and then the later call wins.
 */
export function rowLink(
  coordinators: readonly GradedSession[],
  file: string,
  row: TableRow,
  writes: (operation: ToolOperation, cwd: string) => boolean,
): StateRowLink {
  const at = `${file}:${row.line}`;
  let link: StateRowLink = { session: coordinators[0]?.id ?? "-", entry: "-", at };
  let latest = -Infinity;

  for (const session of coordinators) {
    for (const operation of session.operations) {
      if (operation.entryId === undefined || !writes(operation, session.cwd)) continue;

      const parsed = Date.parse(operation.calledAt ?? "");
      const time = Number.isFinite(parsed) ? parsed : -Infinity;

      if (link.entry === "-" || time >= latest) {
        link = { session: session.id, entry: operation.entryId, at };
        latest = time;
      }
    }
  }

  return link;
}
