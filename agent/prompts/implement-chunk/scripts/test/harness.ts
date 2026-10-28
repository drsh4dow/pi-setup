import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export const scriptsDir = fileURLToPath(new URL("..", import.meta.url));

export const promptsDir = join(scriptsDir, "..", "..");

export const cli = join(scriptsDir, "chunk.ts");

export const UNITS_HEADER =
  "id\tticket\tintake_state\tfinal_pr\tstate\tbranch\tintermediate_pr\thead_sha\tbrief";

/** The ledger header chunk creates outside a sh4dow run, byte-identical to the one before risk calls. */
export const LEDGER_HEADER = "pr\thead_sha\toutcome\tevidence\trecorded_at";

/** The ledger header chunk creates in a state folder whose `mode` file reads sh4dow. */
export const RISK_LEDGER_HEADER = "pr\thead_sha\toutcome\tevidence\trisk\trisk_reason\trecorded_at";

export const DEFINED_OUTCOMES = [
  "live-deployed-verified",
  "live-ui-verified",
  "unit-test-verified",
  "type-check-only",
  "not-applicable",
  "fails-identically-at-base",
  "accepted-gap",
  "isolated-pass-flake",
  "verifier-blocked",
  "verifier-failed",
  "live-failed",
];

export function sha(hex: string): string {
  return hex.repeat(40).slice(0, 40);
}

export function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "chunk-cli-"));

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

export interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function run(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  entry = cli,
): Run {
  const result = spawnSync(entry, args, { encoding: "utf8", env: { ...process.env, ...env } });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export interface PrFixture {
  readonly number: number;
  readonly repo?: string;
  readonly head: string;
  readonly headRefName?: string;
  readonly baseRefName?: string;
  readonly state?: "OPEN" | "MERGED" | "CLOSED";
  readonly mergeStateStatus?: string;
  readonly mergeCommit?: string;
  readonly reviewRequests?: readonly { readonly login?: string; readonly slug?: string }[];
}

export interface Fixture {
  readonly units: readonly (readonly [string, string, string])[];
  /** Ledger rows: pr, sha, outcome, evidence, and optionally a risk level and its reason. */
  readonly ledger?: readonly (
    | readonly [string, string, string, string]
    | readonly [string, string, string, string, string, string]
  )[];
  readonly prs?: readonly PrFixture[];
}

/** A state folder with units.tsv and ledger.tsv, and a stub `gh` that answers from `prs`. */
export function chunk(t: TestContext, fixture: Fixture) {
  const root = scratch(t);
  const state = join(root, "state");
  const stub = join(root, "gh");
  const bin = join(root, "bin");

  mkdirSync(state);
  mkdirSync(stub);
  mkdirSync(bin);
  writeFileSync(
    join(state, "units.tsv"),
    [
      UNITS_HEADER,
      ...fixture.units.map(([id, ticket, finalPr]) =>
        [id, ticket, "open", finalPr, "", "", "", "", ""].join("\t"),
      ),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(state, "ledger.tsv"),
    [
      RISK_LEDGER_HEADER,
      ...(fixture.ledger ?? []).map((row) =>
        [...row, ...(row.length === 4 ? ["", ""] : []), "2026-10-23T19:57:00Z"].join("\t"),
      ),
    ].join("\n") + "\n",
  );

  for (const pr of fixture.prs ?? []) {
    writeFileSync(
      join(stub, `${pr.number}.json`),
      JSON.stringify({
        number: pr.number,
        url: `https://github.com/${pr.repo ?? "owner/repo"}/pull/${pr.number}`,
        headRefOid: pr.head,
        headRefName: pr.headRefName ?? `chunk/c/${pr.number}`,
        baseRefName: pr.baseRefName ?? "main",
        state: pr.state ?? "OPEN",
        reviewRequests: pr.reviewRequests ?? [{ __typename: "User", login: "alice" }],
        mergeStateStatus: pr.mergeStateStatus ?? "BLOCKED",
        mergeCommit: pr.mergeCommit === undefined ? null : { oid: pr.mergeCommit },
      }),
    );
  }

  // The stub answers only the call the report contract names, so a missing field fails loudly.
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
[ "$1 $2 $4" = "pr view --json" ] || { echo "unexpected gh call: $*" >&2; exit 2; }
for field in url headRefOid headRefName baseRefName state reviewRequests mergeStateStatus; do
  case ",$5," in *",$field,"*) ;; *) echo "missing field $field" >&2; exit 2 ;; esac
done
[ -f "${stub}/$3.json" ] || { echo "no pull requests found for $3" >&2; exit 1; }
cat "${stub}/$3.json"
`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };

  return {
    state,
    report: (entry = cli) => run(["--state", state, "report"], env, entry),
  };
}

export function rowOf(output: string, ticket: string): string {
  const row = output.split("\n").find((line) => line.startsWith(`| ${ticket} |`));

  assert.ok(row !== undefined, `no row for ${ticket} in:\n${output}`);

  return row;
}

export function cellsOf(row: string): string[] {
  return row
    .slice(2, -2)
    .split(" | ")
    .map((cell) => cell.trim());
}
