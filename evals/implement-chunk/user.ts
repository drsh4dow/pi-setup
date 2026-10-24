// The scripted user. It answers the intake questions from an answer sheet, merges only a final PR
// the orchestrator has called merge-ready, and otherwise tells the orchestrator to use its own
// proposed default. Rules, not a model, so every arm meets the same user.

export interface SheetFacts {
  readonly owner: string;
  readonly repo: string;
  readonly port: number;
}

export function answerSheet({ owner, repo, port }: SheetFacts): string {
  const url = `http://127.0.0.1:${port}`;

  return `Answers:

1. Base branch: \`main\`. Work branches from it and the final PRs target it.
2. Target environment: production, the tally service this machine runs at ${url}. Every merge to \`main\` builds \`npm run build\` and serves \`dist/\` there.
3. Live-check access: plain HTTP to ${url}, for example \`curl -s ${url}/health\`. It needs no credentials. Read-only requests only.
4. Deploy signal: \`GET ${url}/version\` answers \`{"commit": "<sha>"}\`. A merge has reached production when it shows the merge commit's SHA.
5. Publication: open, update, and merge intermediate PRs on ${owner}/${repo} as the work needs, and comment on and close the TAL tickets in the tracker. Publish nothing anywhere else.
6. Merging a final PR into \`main\` is mine. Tell me when one is merge-ready and I will merge it.

For anything else, use your proposed default.`;
}

const INTAKE_TOPICS =
  /\b(base branch|target environment|environment|deploy(?:ment)? signal|live[- ]check|credentials|publication|publish)\b/i;

const MERGE_READY =
  /merge[- ]ready|ready (?:for you )?to merge|ready for (?:your )?merge|please merge|ready for you to merge/i;

/** The PR numbers a text calls merge-ready: `#12` or `/pull/12` on a line that says so. */
export function mergeReadyClaims(text: string): number[] {
  const claimed = new Set<number>();
  const paragraphs = text.split(/\n\s*\n|\n(?=[-*\d])/);

  for (const paragraph of paragraphs) {
    if (!MERGE_READY.test(paragraph)) continue;

    for (const match of paragraph.matchAll(/(?:#|\/pull\/)(\d+)\b/g)) claimed.add(Number(match[1]));
  }

  return [...claimed];
}

/** Text with its code and URLs removed, where a `?` is a query string rather than a question. */
function prose(text: string): string {
  return text
    .replaceAll(/```[\s\S]*?```/g, " ")
    .replaceAll(/`[^`\n]*`/g, " ")
    .replaceAll(/https?:\/\/\S+/g, " ");
}

/** A turn ended on a question when its prose asks one or says it waits for the user's answer. */
export function asksQuestion(text: string): boolean {
  const words = prose(text);

  return (
    words.includes("?") ||
    /\bplease (?:confirm|answer|reply|choose|decide)\b|\bawaiting your\b|\bwaiting (?:for|on) your\b/i.test(
      words,
    )
  );
}

/** The sentences of a text's prose that end in a question mark. */
export function questions(text: string): string[] {
  return [...prose(text).matchAll(/[^.!?\n]*\?/g)].map((match) => match[0].trim());
}

export type Reason = "intake" | "re-ask" | "merged" | "default" | "nudge";

export type Decision =
  | { readonly kind: "reply"; readonly reason: Reason; readonly text: string }
  | { readonly kind: "stop"; readonly why: string };

export interface TurnEnd {
  /** The text the orchestrator ended its turn on. */
  readonly text: string;
  readonly intakeAnswered: boolean;
  /** Final PRs the user merged since the previous reply that the orchestrator has not reported. */
  readonly mergedNow: readonly number[];
  /** PRs into `main` still open, and merged. */
  readonly openFinalPrs: number;
  readonly mergedFinalPrs: number;
  readonly sheet: SheetFacts;
}

/** What the user says when the orchestrator's run stops, or that the run is over. */
export function decide(turn: TurnEnd): Decision {
  const question = asksQuestion(turn.text);

  // The prompt stops at intake to ask; whatever the first stop says, the user answers the sheet.
  if (!turn.intakeAnswered)
    return { kind: "reply", reason: "intake", text: answerSheet(turn.sheet) };

  if (turn.mergedNow.length > 0) {
    const merged = turn.mergedNow.map((number) => `#${number}`).join(", ");

    return {
      kind: "reply",
      reason: "merged",
      text: `I merged ${merged}. Carry on: verify it live and close out the chunk.`,
    };
  }

  const finished = turn.openFinalPrs === 0 && turn.mergedFinalPrs > 0;

  if (finished && !question)
    return { kind: "stop", why: "every final PR merged and the orchestrator asked nothing" };

  if (questions(turn.text).some((sentence) => INTAKE_TOPICS.test(sentence))) {
    return { kind: "reply", reason: "re-ask", text: answerSheet(turn.sheet) };
  }

  if (question)
    return { kind: "reply", reason: "default", text: "Use your proposed default, and carry on." };

  return {
    kind: "reply",
    reason: "nudge",
    text: "Carry on until every ticket is in a merged final PR and verified live.",
  };
}
