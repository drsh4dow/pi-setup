// Reads a chunk state folder's units.tsv and ledger.tsv by header name, so past layouts still
// read, and looks up the pull requests they name through gh.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, relative, sep } from "node:path";
import { promisify } from "node:util";
import { Option, Schema } from "effect";

export interface TableRow {
  /** 1-based line in the file. */
  readonly line: number;
  readonly cell: (column: string) => string;
}

export function readTable(path: string): TableRow[] {
  if (!existsSync(path)) return [];

  const [header = "", ...rows] = readFileSync(path, "utf8").split("\n");
  const columns = header.split("\t");

  return rows.flatMap((row, index) => {
    if (row.trim() === "") return [];

    const cells = row.split("\t");

    return [
      { line: index + 2, cell: (column: string) => cells[columns.indexOf(column)]?.trim() ?? "" },
    ];
  });
}

export interface PrRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export const formatPr = (ref: PrRef) => `${ref.owner}/${ref.repo}#${ref.number}`;

type LooseRef =
  | { readonly form: "full"; readonly ref: PrRef }
  | { readonly form: "repo"; readonly repo: string; readonly number: number }
  | { readonly form: "bare"; readonly number: number };

/** Every pull request reference in a state-file cell: a URL, `owner/repo#n`, `repo#n`, or a bare number. */
export function looseRefs(cell: string): LooseRef[] {
  const refs: LooseRef[] = [];

  for (const token of cell.split(/[\s,]+/)) {
    const url = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(token);
    const full = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(token);
    const repo = /^([\w.-]+)#(\d+)$/.exec(token);
    const bare = /^#?(\d+)$/.exec(token);
    const parts = url ?? full;

    if (parts)
      refs.push({
        form: "full",
        ref: { owner: parts[1], repo: parts[2], number: Number(parts[3]) },
      });
    else if (repo) refs.push({ form: "repo", repo: repo[1], number: Number(repo[2]) });
    else if (bare) refs.push({ form: "bare", number: Number(bare[1]) });
  }

  return refs;
}

/** Resolves short references against the repositories the chunk's state files name in full. */
export function resolver(cells: readonly string[]) {
  const repos = new Map<string, PrRef>();

  for (const loose of cells.flatMap(looseRefs)) {
    if (loose.form === "full") repos.set(`${loose.ref.owner}/${loose.ref.repo}`, loose.ref);
  }

  const known = [...repos.values()];

  return (loose: LooseRef): PrRef | undefined => {
    if (loose.form === "full") return loose.ref;

    const candidates =
      loose.form === "repo" ? known.filter((ref) => ref.repo === loose.repo) : known;

    const owners = new Set(candidates.map((ref) => `${ref.owner}/${ref.repo}`));

    if (owners.size !== 1) return undefined;

    return { owner: candidates[0].owner, repo: candidates[0].repo, number: loose.number };
  };
}

export interface PullRequest {
  readonly state: string;
  /** The head the pull request had last: for a merged one, the head it merged at. */
  readonly headRefOid: string;
  readonly headRefName: string;
}

const decodePullRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ state: Schema.String, headRefOid: Schema.String, headRefName: Schema.String }),
  ),
);

export class CannotRun extends Error {}

const run = promisify(execFile);

/** The pull request as `gh` reports it, or none when `gh` finds no such pull request. */
export async function ghPullRequest(ref: PrRef): Promise<PullRequest | undefined> {
  const args = ["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`];

  try {
    const { stdout } = await run("gh", [...args, "--json", "state,headRefOid,headRefName"]);

    return Option.getOrUndefined(decodePullRequest(stdout));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CannotRun("gh is not on PATH, so merged heads cannot be read");
    }

    return undefined;
  }
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The paths a chunk's state folder has had: `<state root>/<project>/implement-chunk/<chunk>`
 * under any project name, since renaming a project moves its state folders, written absolute or
 * from `~/`.
 */
export function stateFolderSource(dir: string): string {
  const chunkParent = dirname(dir);
  const stateRoot = dirname(dirname(chunkParent));
  const tail = `/[^/\\s"'\\\\]+/${escapeRegExp(basename(chunkParent))}/${escapeRegExp(basename(dir))}`;
  const home = homedir();
  const roots = [escapeRegExp(stateRoot)];

  if (stateRoot.startsWith(home + sep)) roots.push(`~/${escapeRegExp(relative(home, stateRoot))}`);

  return `(?:${roots.join("|")})${tail}`;
}

export function insideStateFolder(path: string, dir: string): boolean {
  return new RegExp(`^${stateFolderSource(dir)}(?:/|$)`).test(path);
}

export const HEX = /\b[0-9a-f]{7,40}\b/g;

/** Whether the text names `sha` in full or by an abbreviation of at least seven characters. */
export function namesSha(text: string, sha: string): boolean {
  return [...text.matchAll(HEX)].some((match) => sha.startsWith(match[0]));
}
