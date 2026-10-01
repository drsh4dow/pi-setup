import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const nonEmptyString = Type.String({ minLength: 1 });

export const commentSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  user: Type.Object({ login: nonEmptyString }),
  body: Type.Union([Type.String(), Type.Null()]),
  updated_at: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  diff_hunk: Type.Optional(Type.String()),
});

export const reviewSchema = Type.Intersect([
  commentSchema,
  Type.Object({ state: nonEmptyString, submitted_at: Type.Optional(Type.String()) }),
]);

export const checkSchema = Type.Object({
  name: nonEmptyString,
  bucket: Type.String(),
  state: nonEmptyString,
  link: Type.String(),
  completedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const prSchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  url: nonEmptyString,
  baseRefName: nonEmptyString,
  headRefName: nonEmptyString,
  baseRefOid: nonEmptyString,
  headRefOid: nonEmptyString,
  state: Type.Optional(Type.String()),
  mergedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  closedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  mergeable: Type.Optional(Type.String()),
  mergeStateStatus: Type.Optional(Type.String()),
  author: Type.Optional(Type.Object({ login: nonEmptyString })),
});

export type PullRequest = Static<typeof prSchema>;

export type Comment = Static<typeof commentSchema>;

export interface PrIdentity {
  host: string;
  owner: string;
  repo: string;
  pr: number;
}

export interface PreviousSnapshot {
  selfLogin?: string;
  threadStates?: Partial<Record<string, boolean>>;
}

export interface SnapshotInput {
  pr: PullRequest;
  issueComments: Comment[];
  reviewComments: Comment[];
  reviews: Static<typeof reviewSchema>[];
  checks: Static<typeof checkSchema>[];
  comparison: { behind_by: number };
  unresolvedReviewCommentIds: Set<number>;
  threadStates: Map<string, boolean>;
  previousThreadStates?: Partial<Record<string, boolean>>;
  selfLogin: string;
  trustedLogins: Set<string>;
}

// JSON crosses the trust boundary here. Check rather than coerce GitHub/state data.
export function parseJson<S extends TSchema>(schema: S, text: string): Static<S> {
  const value: unknown = JSON.parse(text);

  if (!Value.Check(schema, value)) throw new Error("JSON does not match its expected schema");

  // Value.Check establishes Static<S>; Oxlint cannot resolve TypeBox's conditional generic here.
  // oxlint-disable-next-line typescript/no-unsafe-return
  return value;
}
