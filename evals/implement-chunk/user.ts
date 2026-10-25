// The scripted user. It answers the intake questions from an answer sheet, merges only a final PR
// the orchestrator has called merge-ready, declines once any work proposed beyond the chunk after
// its final PRs merged, and otherwise tells the orchestrator to use its own proposed default.
// Rules, not a model, so every arm meets the same user.

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

// A question about the project's domain docs is not an intake fact, whatever else it names, so it
// gets the default like any other question.
const DOMAIN_DOCS = /\b(?:glossary|ADR(?:-?\d+)?s?|docs\/adr)\b/i;

// A claim states that a PR is ready now. "Driving #5 to merge-ready" or "merge once it is ready"
// is a plan, not a claim.
const MERGE_READY_CLAIM =
  /\b(?:is|are|it's|now)\s+(?:now\s+)?(?:merge[- ]ready|ready (?:for you )?to merge|ready for (?:your )?merge)\b|\bplease merge\b|\byou can (?:now )?merge\b|^\W*merge[- ]ready\W*[:—]/im;

const NOT_YET =
  /\bnot\b|n't\b|\b(?:until|once|before|when|if|after|toward|towards)\b|\bto merge[- ]ready\b/i;

export interface MergeReadyClaim {
  readonly pr: number;
  /** The sentence that made the claim, kept so a reader can audit every merge the user made. */
  readonly sentence: string;
}

const prNumbers = (text: string) =>
  [...text.matchAll(/(?:#|\/pull\/)(\d+)\b/g)].map((match) => Number(match[1]));

/** The PRs a text calls merge-ready now: `#12` or `/pull/12` in the claiming sentence, or else in its paragraph. */
export function mergeReadyClaims(text: string): MergeReadyClaim[] {
  const claims = new Map<number, string>();

  for (const paragraph of text.split(/\n\s*\n|\n(?=\s*[-*|\d])/)) {
    for (const sentence of paragraph.split(/(?<=[.!?])\s+|\n/)) {
      if (!MERGE_READY_CLAIM.test(sentence) || NOT_YET.test(sentence)) continue;

      const named = prNumbers(sentence);

      for (const pr of named.length > 0 ? named : prNumbers(paragraph)) {
        if (!claims.has(pr)) claims.set(pr, sentence.trim().slice(0, 300));
      }
    }
  }

  return [...claims].map(([pr, sentence]) => ({ pr, sentence }));
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

// Edits and work outside the chunk: the harness's or the project's agent files, and follow-ups.
const BEYOND_CHUNK =
  /\b(?:prompts?|agent (?:files?|docs?)|AGENTS\.md|SYSTEM\.md|CLAUDE\.md|skills?|standing orders?|harness|follow[- ]?ups?|follow[- ]on|(?:new|more) tickets?|file (?:\w+ ){0,3}tickets?|docs PR)\b/i;

const PROPOSAL = /\?|\b(?:propose|proposal|suggest|recommend|please|want me to|would you like)\b/i;

/**
 * Whether a text proposes work beyond the chunk: a question or proposal sentence that names an
 * agent file, the harness, or a follow-up. Inline code stays, since a file name sits in backticks.
 */
export function proposesBeyondChunk(text: string): boolean {
  const sentences = text
    .replaceAll(/```[\s\S]*?```/g, " ")
    .replaceAll("`", "")
    .replaceAll(/https?:\/\/\S+/g, " ")
    .split(/(?<=[.!?])\s+|\n/);

  return sentences.some((sentence) => PROPOSAL.test(sentence) && BEYOND_CHUNK.test(sentence));
}

export const BEYOND_CHUNK_REPLY =
  "Thanks. List them in your close report; do not make these edits in this chunk.";

export type Reason = "intake" | "re-ask" | "merged" | "beyond-chunk" | "default" | "nudge";

export type Decision =
  | { readonly kind: "reply"; readonly reason: Reason; readonly text: string }
  | { readonly kind: "stop"; readonly why: string };

export interface TurnEnd {
  /** The text the orchestrator ended its turn on. */
  readonly text: string;
  readonly intakeAnswered: boolean;
  /** Final PRs the user merged since the previous reply that the orchestrator has not reported. */
  readonly mergedNow: readonly number[];
  /** The chunk's own final PRs (see `ChunkFinalPrs` in drive.ts) still open, and merged. */
  readonly openFinalPrs: number;
  readonly mergedFinalPrs: number;
  /** The user already declined work beyond the chunk once. */
  readonly beyondChunkDeclined: boolean;
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

  // After the chunk's final PRs merged, the user takes no new work: one decline, then the close.
  if (finished && proposesBeyondChunk(turn.text)) {
    if (!turn.beyondChunkDeclined)
      return { kind: "reply", reason: "beyond-chunk", text: BEYOND_CHUNK_REPLY };

    return {
      kind: "stop",
      why: "every final PR of the chunk merged, and the orchestrator proposed work beyond the chunk again after the decline",
    };
  }

  if (finished && !question)
    return { kind: "stop", why: "every final PR merged and the orchestrator asked nothing" };

  if (
    questions(turn.text).some(
      (sentence) => INTAKE_TOPICS.test(sentence) && !DOMAIN_DOCS.test(sentence),
    )
  ) {
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
