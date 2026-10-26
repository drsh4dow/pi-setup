import type {
  Check,
  ChecksFastPath,
  CommitRollup,
  GitHubReader,
  OpenPullRequest,
  PrContext,
  PullRequestFacts,
  Repository,
  RawReview,
  RawReviewThread,
  ReviewPage,
  ReviewThread,
  ReviewThreadPage,
  RollupPage,
} from "./types.ts";
import { parsePrNumber } from "./types.ts";

export interface FakeReaderOptions {
  readonly facts?: Partial<Omit<PullRequestFacts, "context">>;
  readonly fastPath?: ChecksFastPath;
  readonly rollupPages?: readonly RollupPage[];
  readonly threads?: readonly ReviewThread[];
  readonly threadPages?: readonly ReviewThreadPage[];
  readonly reviews?: readonly RawReview[];
  readonly reviewPages?: readonly ReviewPage[];
  readonly commitRollups?: readonly CommitRollup[];
  readonly openPullRequests?: readonly OpenPullRequest[];
  readonly origin?: Repository | null;
  readonly current?: PrContext;
}

function toRawThread(thread: ReviewThread): RawReviewThread {
  return { id: thread.id, firstComment: thread.firstComment, resolved: false };
}

export function passingCheck(name = "ci"): Check {
  return {
    kind: "passed",
    name,
    reportedState: "SUCCESS",
    description: "",
    link: "",
    workflow: "",
  };
}

export function pendingCheck(name = "ci"): Check {
  return {
    kind: "pending",
    name,
    reportedState: "PENDING",
    description: "",
    link: "",
    workflow: "",
  };
}

export function failedCheck(name = "ci"): Check {
  return {
    kind: "failed",
    name,
    reportedState: "FAILURE",
    description: "",
    link: "",
    workflow: "",
  };
}

/** A non-empty review by a bot author on one head commit, or an empty one when body is "". */
export function botReview(args: {
  readonly id: string;
  readonly author?: string;
  readonly commitOid: string;
  readonly body: string;
  readonly submittedAt: string;
}): RawReview {
  return {
    id: args.id,
    authorLogin: args.author ?? "acme-review[bot]",
    authorIsBot: true,
    body: args.body,
    state: "COMMENTED",
    commitOid: args.commitOid,
    submittedAt: args.submittedAt,
  };
}

interface Selection {
  readonly fields: ReadonlyMap<string, Selection | null>;
  readonly fragments: readonly { readonly on: string; readonly selection: Selection }[];
}
function parseSelection(
  tokens: readonly string[],
  start: number
): readonly [Selection, number] {
  const fields = new Map<string, Selection | null>();
  const fragments: { on: string; selection: Selection }[] = [];
  let index = start + 1;
  while (tokens[index] !== "}") {
    if (index >= tokens.length) throw new Error("unbalanced selection set");
    if (tokens[index] === "...") {
      const on = tokens[index + 2];
      if (tokens[index + 1] !== "on" || on === undefined)
        throw new Error("only inline fragments are supported");
      const [selection, next] = parseSelection(tokens, index + 3);
      fragments.push({ on, selection });
      index = next;
      continue;
    }
    const name = tokens[index++];
    if (name === undefined || !/^\w+$/.test(name))
      throw new Error(`unsupported token ${name}`);
    if (tokens[index] === "(") {
      let depth = 0;
      do {
        if (tokens[index] === "(") depth += 1;
        else if (tokens[index] === ")") depth -= 1;
        index += 1;
      } while (depth > 0);
    }
    if (tokens[index] === "{") {
      const [selection, next] = parseSelection(tokens, index);
      fields.set(name, selection);
      index = next;
    } else fields.set(name, null);
  }
  return [{ fields, fragments }, index + 1];
}
function select(value: unknown, selection: Selection): unknown {
  if (Array.isArray(value)) return value.map((item) => select(item, selection));
  if (typeof value !== "object" || value === null) return value;
  const source = new Map(Object.entries(value));
  const fields = new Map(selection.fields);
  for (const fragment of selection.fragments)
    if (source.get("__typename") === fragment.on)
      for (const [name, sub] of fragment.selection.fields) fields.set(name, sub);
  const selected: Record<string, unknown> = {};
  for (const [name, sub] of fields) {
    if (!source.has(name)) continue;
    const field = source.get(name);
    selected[name] = sub === null ? field : select(field, sub);
  }
  return selected;
}
/**
 * The GraphQL response a server gives for this query: `data` keeps only the
 * fields the query selects, so a field the query forgets is absent. Inline
 * fragments apply when the fixture object's `__typename` matches.
 */
export function selectedFields(query: string, response: unknown): unknown {
  if (typeof response !== "object" || response === null) return response;
  const tokens: readonly string[] = query.match(/\.\.\.|\$?\w+|[{}():!,]/g) ?? [];
  const [selection] = parseSelection(tokens, tokens.indexOf("{"));
  const data = new Map(Object.entries(response)).get("data");
  return { ...response, data: select(data, selection) };
}

export function fakeReader(
  options: FakeReaderOptions = {}
): GitHubReader & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  const context = options.current ?? {
    owner: "owner",
    repo: "repo",
    number: parsePrNumber(1),
  };
  const defaults: PullRequestFacts = {
    context,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefOid: "head",
    headRefName: "feature",
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
  };
  let page = 0;
  let threadPage = 0;
  let reviewPage = 0;
  return {
    calls,
    async originRepo() {
      calls.push("originRepo");
      return options.origin === undefined
        ? { owner: "owner", repo: "repo" }
        : options.origin;
    },
    async currentPr(pr) {
      calls.push("currentPr");
      return { ...context, number: pr ?? context.number };
    },
    async pullRequest(requested) {
      calls.push("pullRequest");
      return { ...defaults, ...options.facts, context: requested };
    },
    async openPullRequests() {
      calls.push("openPullRequests");
      return options.openPullRequests ?? [];
    },
    async checksFastPath() {
      calls.push("checksFastPath");
      return options.fastPath ?? { kind: "checks", checks: [passingCheck()] };
    },
    async checkRollupPage(_requested, after) {
      calls.push(`checkRollupPage:${after ?? "null"}`);
      return (
        options.rollupPages?.[page++] ?? {
          kind: "contexts",
          checks: [],
          endCursor: null,
        }
      );
    },
    async reviewThreadPage(_requested, after) {
      calls.push(`reviewThreadPage:${after ?? "null"}`);
      return options.threadPages?.[threadPage++] ?? {
        threads: (options.threads ?? []).map(toRawThread),
        endCursor: null,
      };
    },
    async reviewPage(_requested, after) {
      calls.push(`reviewPage:${after ?? "null"}`);
      return (
        options.reviewPages?.[reviewPage++] ?? {
          reviews: options.reviews ?? [],
          endCursor: null,
        }
      );
    },
    async commitRollups() {
      calls.push("commitRollups");
      return options.commitRollups ?? [{ oid: "head", state: "SUCCESS" }];
    },
  };
}
