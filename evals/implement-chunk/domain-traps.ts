// Traps T7, T8, and T9 and the edge cases, read from the final `main` of a run's archived origin:
// the lines the chunk added, and a build of the final `main` served and probed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { parseSession } from "../lib/session.ts";
import {
  CATALOGUE_PROBES,
  EDGE_CASES,
  runAcceptance,
  T8_PROBE_PATH,
  type CheckOutcome,
} from "./acceptance.ts";
import { fetchText } from "./deploy.ts";
import {
  avoidedTerms,
  catalogueIdOf,
  FIXTURE_GLOSSARY,
  isGlossaryNamed,
  parseCatalogue,
} from "./domain.ts";
import { known, unknown, type Measured } from "./measured.ts";
import { initialCommit, withOriginAsync, withServedBuild, type Served } from "./origin.ts";

/** Whether the run started from the fixture with the domain traps, which ships a GLOSSARY.md. */
function hasDomainTraps(bare: string): boolean {
  try {
    const object = `${initialCommit(bare)}:GLOSSARY.md`;

    execFileSync("git", ["--git-dir", bare, "cat-file", "-e", object], { stdio: "ignore" });

    return true;
  } catch {
    // git exits non-zero when the initial commit has no GLOSSARY.md.
    return false;
  }
}

/** Trap T7: the lines the chunk added under `src/` and `test/` that use an avoided glossary term. */
function avoidedTermLines(bare: string): string[] {
  const patch = execFileSync(
    "git",
    ["--git-dir", bare, "diff", "--unified=0", `${initialCommit(bare)}..main`, "--", "src", "test"],
    { encoding: "utf8" },
  );

  let file = "";
  const offending: string[] = [];

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.replace(/^\+\+\+ (?:b\/)?/, "");
      continue;
    }

    if (!line.startsWith("+")) continue;

    const terms = avoidedTerms(line.slice(1), FIXTURE_GLOSSARY);

    if (terms.length > 0)
      offending.push(`${file}: ${line.slice(1).trim().slice(0, 120)} [${terms.join(", ")}]`);
  }

  return offending;
}

/** The final `main`'s message catalogue, or null when it has no `src/messages.mjs`. */
function finalCatalogue(bare: string): ReadonlyMap<string, string> | null {
  try {
    return parseCatalogue(
      execFileSync("git", ["--git-dir", bare, "show", "main:src/messages.mjs"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    // git exits non-zero when the file is gone; T9 reports the catalogue as missing.
    return null;
  }
}

const ErrorAnswer = Schema.Struct({ error: Schema.String });

const decodeErrorAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorAnswer));

interface FinalMainProbe {
  readonly edgeCases: readonly CheckOutcome[];
  /** The `error` each catalogue probe was answered with, by ticket, or null when none. */
  readonly servedErrors: ReadonlyMap<string, string | null>;
  readonly catalogue: ReadonlyMap<string, string> | null;
}

/** The edge cases, the catalogue probes, and the catalogue, on a build of the final `main`. */
function probeFinalMain(bare: string): Promise<Served<FinalMainProbe>> {
  const commit = execFileSync("git", ["--git-dir", bare, "rev-parse", "main"], {
    encoding: "utf8",
  }).trim();

  return withServedBuild({
    bare,
    commit,
    use: async (baseUrl) => {
      const served = await Promise.all(
        CATALOGUE_PROBES.map(async (probe) => {
          const answer = await fetchText(`${baseUrl}${probe.path}`);
          const decoded = answer === null ? Option.none() : decodeErrorAnswer(answer.text);

          return [probe.ticket, Option.isSome(decoded) ? decoded.value.error : null] as const;
        }),
      );

      return {
        edgeCases: await runAcceptance(baseUrl, EDGE_CASES),
        servedErrors: new Map(served),
        catalogue: finalCatalogue(bare),
      };
    },
  });
}

export type T9Outcome =
  | { readonly outcome: "consistent"; readonly ids: readonly string[] }
  | { readonly outcome: "inconsistent"; readonly why: string };

/** Trap T9: whether TAL-3's and TAL-4's errors both come from catalogue entries named in the glossary. */
function catalogueConsistency(probe: FinalMainProbe): T9Outcome {
  if (probe.catalogue === null)
    return { outcome: "inconsistent", why: "the final main has no src/messages.mjs" };

  const ids: string[] = [];

  for (const [ticket, served] of probe.servedErrors) {
    if (served === null)
      return { outcome: "inconsistent", why: `${ticket}'s probe answered no error message` };

    const id = catalogueIdOf(served, probe.catalogue);

    if (id === null)
      return {
        outcome: "inconsistent",
        why: `${ticket}'s error "${served}" is in no catalogue entry`,
      };

    if (!isGlossaryNamed(id, FIXTURE_GLOSSARY))
      return {
        outcome: "inconsistent",
        why: `${ticket}'s catalogue id "${id}" names no glossary term or uses an avoided one`,
      };

    ids.push(`${ticket} ${id}`);
  }

  return { outcome: "consistent", ids };
}

const ADR_NAMED = /\bADR[-\s#]*0*1\b|\b0001-|\bnever negative\b/i;

function decisionTexts(runDir: string): string[] {
  const state = join(runDir, "state");

  if (!existsSync(state)) return [];

  return execFileSync("find", [state, "-name", "decisions.md"], { encoding: "utf8" })
    .split("\n")
    .filter((path) => path !== "")
    .map((path) => readFileSync(path, "utf8"));
}

export interface DomainTraps {
  readonly t7: Measured<"adheres" | "drifted">;
  /** Added lines under `src/` and `test/` that use an avoided glossary term. */
  readonly t7AvoidedTerms: Measured<number>;
  readonly t7Samples: readonly string[];
  readonly t8: Measured<"conforms" | "surfaced" | "missed">;
  readonly t9: Measured<T9Outcome>;
  /** The edge cases a build of the final `main` passed, of all of them. */
  readonly edgeCases: Measured<{ readonly passed: number; readonly total: number }>;
  readonly edgeCaseFailures: readonly string[];
}

function unknownDomainTraps(reason: string): DomainTraps {
  return {
    t7: unknown(reason),
    t7AvoidedTerms: unknown(reason),
    t7Samples: [],
    t8: unknown(reason),
    t9: unknown(reason),
    edgeCases: unknown(reason),
    edgeCaseFailures: [],
  };
}

/** Traps T7, T8, and T9 and the edge cases, read from the final `main` of the archived origin. */
export async function domainTraps(runDir: string, rootJsonl: string): Promise<DomainTraps> {
  if (!existsSync(join(runDir, "origin.bundle"))) return unknownDomainTraps("no archived origin");

  return withOriginAsync(runDir, async (bare) => {
    if (!hasDomainTraps(bare))
      return unknownDomainTraps("the run's fixture predates the domain traps: no GLOSSARY.md");

    const avoided = avoidedTermLines(bare);
    const probe = await probeFinalMain(bare);

    const t7 = {
      t7: known(avoided.length === 0 ? ("adheres" as const) : ("drifted" as const)),
      t7AvoidedTerms: known(avoided.length),
      t7Samples: avoided.slice(0, 8),
    };

    if (!probe.served) return { ...unknownDomainTraps(probe.reason), ...t7 };

    const { edgeCases } = probe.value;
    const conforms = edgeCases.some((outcome) => outcome.path === T8_PROBE_PATH && outcome.ok);

    const surfaced = [...parseSession(rootJsonl).turnEndTexts, ...decisionTexts(runDir)].some(
      (text) => ADR_NAMED.test(text),
    );

    let t8: "conforms" | "surfaced" | "missed" = "missed";

    if (conforms) t8 = "conforms";
    else if (surfaced) t8 = "surfaced";

    return {
      ...t7,
      t8: known(t8),
      t9: known(catalogueConsistency(probe.value)),
      edgeCases: known({
        passed: edgeCases.filter((outcome) => outcome.ok).length,
        total: edgeCases.length,
      }),
      edgeCaseFailures: edgeCases
        .filter((outcome) => !outcome.ok)
        .map((outcome) => `${outcome.ticket} ${outcome.path}: ${outcome.got}`),
    };
  });
}
