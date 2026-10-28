// Writes a grade as sessions.tsv and findings.tsv, and as the summary the CLI prints.

import { skillLoads } from "../lib/session.ts";
import { FINDING_CLASSES, type ChunkGrade, type FindingClass } from "./model.ts";

/** The classes counted from a units.tsv or ledger.tsv row, linked to the entry that wrote it. */
const STATE_ROW_CLASSES: ReadonlySet<FindingClass> = new Set<FindingClass>([
  "stale-verdict",
  "report-only-merge",
  "unterminated-subagent",
]);

const cell = (value: string | number) => String(value).replace(/[\t\n\r]+/g, " ");

const tsv = (rows: readonly (readonly (string | number)[])[]) =>
  rows.map((row) => row.map(cell).join("\t")).join("\n") + "\n";

/** The skill table's size in tokens, estimated at four characters per token. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function sessionsTable(grades: readonly ChunkGrade[]): string {
  return tsv([
    [
      "session",
      "file",
      "project",
      "chunk",
      "mode",
      "role",
      "parent",
      "depth",
      "skill_table_chars",
      "skill_table_tokens",
      "skill_table_tokens_source",
      "skills_read",
    ],
    ...grades.flatMap(({ sessions }) =>
      sessions.map((session) => [
        session.id,
        session.file,
        session.chunk.project,
        session.chunk.name,
        session.mode,
        session.role,
        session.parent ?? "-",
        session.depth,
        session.skillTable.length,
        estimateTokens(session.skillTable),
        "estimate",
        skillLoads(session.operations)
          .map((load) => load.skill)
          .join(",") || "-",
      ]),
    ),
  ]);
}

export function findingsTable(grades: readonly ChunkGrade[]): string {
  return tsv([
    ["session", "entry", "class", "detail"],
    ...grades.flatMap(({ findings }) =>
      findings.map((finding) => [
        finding.session,
        finding.entry,
        finding.findingClass,
        finding.detail,
      ]),
    ),
  ]);
}

export function summary(grades: readonly ChunkGrade[]): string {
  return grades
    .map(({ chunk, sessions, findings, unlinkedLaunches }) => {
      const uncounted = sessions.flatMap((session) => session.uncountedLaunches).length;

      const sessionLines = sessions.map((session) => {
        const skills = skillLoads(session.operations).map((load) => load.skill);
        const tableSkills = session.skillTable.match(/<skill>/g)?.length ?? 0;

        return [
          `  ${"  ".repeat(session.depth)}${session.id} ${session.mode} ${session.role} depth ${session.depth}`,
          `skill table ${tableSkills} skills, ${session.skillTable.length} chars, ~${estimateTokens(session.skillTable)} tokens (estimate)`,
          `read ${skills.join(", ") || "none"}`,
        ].join(" | ");
      });

      const counts = FINDING_CLASSES.map(
        (findingClass) =>
          `  ${findingClass.padEnd(22)}${findings.filter((finding) => finding.findingClass === findingClass).length}`,
      );

      const unwritten = findings.filter(
        (finding) => STATE_ROW_CLASSES.has(finding.findingClass) && finding.entry === "-",
      ).length;

      const caveat = [
        ...(unlinkedLaunches === 0
          ? []
          : [
              `  ${unlinkedLaunches} launches name no child session, so their trees are not graded and report-only-merge is an upper bound`,
            ]),
        ...(uncounted === 0
          ? []
          : [
              `  ${uncounted} launch ${uncounted === 1 ? "call" : "calls"} not counted: codemode cut ${uncounted === 1 ? "its recorded command" : "their recorded commands"} short and no child session was started, so a dry run cannot be told from a launch; warnings name each`,
            ]),
        ...(unwritten === 0
          ? []
          : [
              `  ${unwritten} state-row ${unwritten === 1 ? "finding names" : "findings name"} no entry: no graded coordinator session holds a tool call that wrote the row, so the detail names its state file and line`,
            ]),
      ];

      return [
        `${chunk.project}/${chunk.name}: ${sessions.length} sessions`,
        ...sessionLines,
        ...counts,
        ...caveat,
      ].join("\n");
    })
    .join("\n\n");
}
