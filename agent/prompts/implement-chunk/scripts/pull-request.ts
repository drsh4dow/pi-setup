import { Schema } from "effect";

/** A PR as the state files name it: `12`, `#12`, `owner/repo#12`, or its GitHub URL. */
export interface PrRef {
  readonly repo: string | null;
  readonly number: number;
}

export function parsePrRef(text: string): PrRef | null {
  const bare = text.match(/^#?(\d+)$/);

  if (bare) return { repo: null, number: Number(bare[1]) };

  const named =
    text.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/) ??
    text.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/);

  const [, repo, number] = named ?? [];

  return repo === undefined || number === undefined ? null : { repo, number: Number(number) };
}

export function formatPrRef(ref: PrRef): string {
  return ref.repo === null ? String(ref.number) : `${ref.repo}#${ref.number}`;
}

/** A bare number names the PR in whichever repository the other side names. */
export function samePr(left: PrRef, right: PrRef): boolean {
  return (
    left.number === right.number &&
    (left.repo === null ||
      right.repo === null ||
      left.repo.toLowerCase() === right.repo.toLowerCase())
  );
}

export const PR_VIEW_FIELDS = [
  "number",
  "url",
  "headRefOid",
  "headRefName",
  "baseRefName",
  "state",
  "reviewRequests",
  "mergeStateStatus",
  "mergeCommit",
] as const;

const ReviewRequest = Schema.Struct({
  login: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

const PrView = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  headRefOid: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
  reviewRequests: Schema.Array(ReviewRequest),
  mergeStateStatus: Schema.String,
  mergeCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
});

/** What `gh pr view --json` reports about a final PR, decoded at the boundary. */
export type PrView = typeof PrView.Type;

export const decodePrView = Schema.decodeUnknownSync(Schema.fromJsonString(PrView));

export function viewRepo(view: PrView): string | null {
  return view.url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//)?.[1] ?? null;
}
