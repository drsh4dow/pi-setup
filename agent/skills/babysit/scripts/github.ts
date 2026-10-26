import { spawn } from "node:child_process";
import type * as T from "./types.ts";
import { nonEmpty, parsePrNumber } from "./types.ts";
export const REVIEW_THREADS_QUERY =
  "\nquery ReviewThreads($owner: String!, $repo: String!, $pr: Int!, $after: String) {\n  repository(owner: $owner, name: $repo) {\n    pullRequest(number: $pr) {\n      reviewThreads(first: 100, after: $after) {\n        pageInfo {\n          hasNextPage\n          endCursor\n        }\n        nodes {\n          id\n          isResolved\n          comments(first: 10) {\n            nodes {\n              body\n              createdAt\n              path\n              line\n              author { login }\n            }\n          }\n        }\n      }\n    }\n  }\n}\n";
export const REVIEWS_QUERY =
  "\nquery Reviews($owner: String!, $repo: String!, $pr: Int!, $after: String) {\n  repository(owner: $owner, name: $repo) {\n    pullRequest(number: $pr) {\n      reviews(first: 100, after: $after) {\n        pageInfo {\n          hasNextPage\n          endCursor\n        }\n        nodes {\n          id\n          body\n          state\n          submittedAt\n          commit { oid }\n          author { __typename login }\n        }\n      }\n    }\n  }\n}\n";
export const PR_COMMIT_STATUS_QUERY =
  "\nquery PrCommitStatuses($owner: String!, $repo: String!, $pr: Int!) {\n  repository(owner: $owner, name: $repo) {\n    pullRequest(number: $pr) {\n      commits(last: 50) {\n        nodes {\n          commit {\n            oid\n            statusCheckRollup {\n              state\n            }\n          }\n        }\n      }\n    }\n  }\n}\n";
export const PR_CHECK_ROLLUP_QUERY =
  "\nquery PrCheckRollup($owner: String!, $repo: String!, $pr: Int!, $after: String) {\n  repository(owner: $owner, name: $repo) {\n    pullRequest(number: $pr) {\n      commits(last: 1) {\n        nodes {\n          commit {\n            statusCheckRollup {\n              contexts(first: 100, after: $after) {\n                pageInfo {\n                  hasNextPage\n                  endCursor\n                }\n                nodes {\n                  __typename\n                  ... on CheckRun {\n                    name\n                    status\n                    conclusion\n                    detailsUrl\n                  }\n                  ... on StatusContext {\n                    context\n                    state\n                    targetUrl\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n}\n";

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export class WatcherQueryError extends Error {
  readonly failure: T.QueryFailure;
  constructor(failure: T.QueryFailure) {
    super(failure.detail);
    this.name = "WatcherQueryError";
    this.failure = failure;
  }
}
export class ChecksUnavailable extends WatcherQueryError {
  constructor(detail: string) {
    super({ kind: "checks-unavailable", retryable: true, detail });
    this.name = "ChecksUnavailable";
  }
}
const firstLine = (value: string): string =>
  value.trim().split(/\r?\n/, 1)[0]?.slice(0, 240) ?? "";
function run(argv: readonly [string, ...string[]]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WatcherQueryError({
      kind: "json-parse",
      retryable: true,
      detail: `${label}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
export async function runJson(argv: readonly [string, ...string[]]): Promise<unknown> {
  const result = await run(argv);
  if (result.code !== 0)
    throw new WatcherQueryError({
      kind: "command-exit",
      retryable: true,
      code: result.code,
      detail:
        firstLine(result.stderr) || `${argv.join(" ")} exited ${result.code}`,
    });
  return parseJson(result.stdout, argv.join(" "));
}
function raw(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
export function missing(path: string, value?: unknown): never {
  throw new WatcherQueryError({
    kind: "missing-key",
    retryable: true,
    detail:
      value === undefined
        ? `missing ${path}`
        : `invalid ${path}: ${raw(value)}`,
    ...(value === undefined ? {} : { rawValue: raw(value) }),
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) missing(path, value);
  return value;
}
export function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) missing(path, value);
  return value;
}
export function at(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    const object = record(current, path.join("."));
    if (!(key in object)) missing(path.join("."));
    current = object[key];
  }
  return current;
}
export function string(value: unknown, path: string): string {
  if (typeof value !== "string") missing(path, value);
  return value;
}
export const optionalString = (value: unknown, path: string): string | null =>
  value === null ? null : string(value, path);
export function enumValue<const V extends readonly string[]>(
  value: unknown,
  values: V,
  path: string
): V[number] {
  if (typeof value === "string")
    for (const candidate of values) if (candidate === value) return candidate;
  return missing(path, value);
}
const nullableEnum = <const V extends readonly string[]>(
  value: unknown,
  values: V,
  path: string
): V[number] | null => (value === null ? null : enumValue(value, values, path));
const MERGE_STATES = [
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "CONFLICTING",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
] as const satisfies readonly T.MergeStateStatus[];
const ROLLUP_STATES = [
  "ERROR",
  "EXPECTED",
  "FAILURE",
  "PENDING",
  "SUCCESS",
] as const;
const REVIEW_DECISIONS = [
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
] as const;
// `gh pr view` reports no review decision as "", not null. Only this field does
// it, so the normalization stays here rather than in nullableEnum, where it
// would stop a genuinely unexpected rollup state from failing closed.
const reviewDecision = (value: unknown): T.ReviewDecision =>
  nullableEnum(
    value === "" ? null : value,
    REVIEW_DECISIONS,
    "pull request.reviewDecision"
  );
function parseRemote(value: string): T.Repository | null {
  let normalized = value.trim();
  if (normalized.startsWith("git@github.com:"))
    normalized = `https://github.com/${normalized.slice(15)}`;
  if (normalized.startsWith("ssh://git@github.com/"))
    normalized = `https://github.com/${normalized.slice(21)}`;
  try {
    const url = new URL(normalized);
    const parts = url.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length !== 2
    )
      return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}
function parsePrUrl(value: string): T.PrContext {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length !== 4 ||
      parts[2] !== "pull"
    )
      throw new Error("not a canonical GitHub pull URL");
    return {
      owner: parts[0],
      repo: parts[1],
      number: parsePrNumber(Number(parts[3])),
    };
  } catch (error) {
    throw new WatcherQueryError({
      kind: "invalid-context-url",
      retryable: false,
      rawValue: value,
      detail: `could not infer owner/repo from PR URL: ${value} (${error instanceof Error ? error.message : String(error)})`,
    });
  }
}
function checkDetails(value: Record<string, unknown>, nameKey: string) {
  return {
    name: string(value[nameKey], nameKey),
    description: typeof value.description === "string" ? value.description : "",
    link:
      typeof value.link === "string"
        ? value.link
        : typeof value.detailsUrl === "string"
          ? value.detailsUrl
          : "",
    workflow: typeof value.workflow === "string" ? value.workflow : "",
  };
}
export function parseFastCheck(value: unknown): T.Check {
  const object = record(value, "check");
  const details = checkDetails(object, "name");
  const state = string(object.state, "check.state").toUpperCase();
  const bucket = string(object.bucket, "check.bucket");
  if (state === "ACTION_REQUIRED") return gateOr("failed", details, state);
  if (bucket === "fail" || ["FAILURE", "ERROR"].includes(state))
    return { ...details, kind: "failed", reportedState: state };
  if (bucket === "pending") return gateOr("pending", details, state);
  if (bucket === "pass")
    return { ...details, kind: "passed", reportedState: state };
  if (bucket === "skipping")
    return { ...details, kind: "skipped", reportedState: state };
  return { ...details, kind: "failed", reportedState: state };
}
// Every read path classifies the owner-approval gate here, so the rule has one
// home. A gate that is pending or waits on an owner approval must not count as
// pending or failed, or the watcher waits on a human.
function gateOr(
  kind: "pending" | "failed",
  details: {
    readonly name: string;
    readonly description: string;
    readonly link: string;
    readonly workflow: string;
  },
  reportedState: string
): T.Check {
  return details.name === "Code Review Gate"
    ? {
        ...details,
        kind: "code-review-gate",
        name: "Code Review Gate",
        reportedState,
      }
    : { ...details, kind, reportedState };
}
export function mapRollupNode(value: unknown): T.Check | null {
  const object = record(value, "rollup node");
  const typename = object.__typename;
  if (typename !== "CheckRun" && typename !== "StatusContext") return null;
  const details = checkDetails(
    object,
    typename === "CheckRun" ? "name" : "context"
  );
  const link =
    typeof object.targetUrl === "string" ? object.targetUrl : details.link;
  if (typename === "CheckRun") {
    const status =
      typeof object.status === "string" ? object.status.toUpperCase() : "";
    const conclusion =
      typeof object.conclusion === "string"
        ? object.conclusion.toUpperCase()
        : "";
    if (status !== "COMPLETED")
      return gateOr("pending", { ...details, link }, "PENDING");
    if (conclusion === "SUCCESS")
      return { ...details, link, kind: "passed", reportedState: "SUCCESS" };
    if (conclusion === "NEUTRAL" || conclusion === "SKIPPED")
      return { ...details, link, kind: "skipped", reportedState: conclusion };
    if (conclusion === "ACTION_REQUIRED")
      return gateOr("failed", { ...details, link }, conclusion);
    return { ...details, link, kind: "failed", reportedState: "FAILURE" };
  }
  const state =
    typeof object.state === "string" ? object.state.toUpperCase() : "";
  if (state === "PENDING" || state === "EXPECTED")
    return gateOr("pending", { ...details, link }, "PENDING");
  return state === "SUCCESS"
    ? { ...details, link, kind: "passed", reportedState: state }
    : { ...details, link, kind: "failed", reportedState: state || "FAILURE" };
}
/** A bot author: GraphQL `__typename` Bot, or a login ending in [bot]. GraphQL drops the suffix, so the type is the main signal. */
export function isBotAuthor(
  typename: string | null,
  login: string | null
): boolean {
  return typename === "Bot" || (login?.endsWith("[bot]") ?? false);
}
/** Reads `author { __typename login }`; a deleted account (`null`) is no author. */
export function parseAuthor(
  value: unknown,
  path: string
): { readonly login: string; readonly isBot: boolean } | null {
  if (value === null) return null;
  const author = record(value, path);
  const login = string(author.login, `${path}.login`);
  const typename =
    typeof author.__typename === "string" ? author.__typename : null;
  return { login, isBot: isBotAuthor(typename, login) };
}
function parseComment(value: unknown): T.ReviewComment {
  const object = record(value, "review comment");
  const author =
    object.author === null
      ? null
      : record(object.author, "review comment.author");
  return {
    authorLogin:
      author === null
        ? null
        : optionalString(author.login, "review comment.author.login"),
    body: string(object.body, "review comment.body"),
    path: optionalString(object.path, "review comment.path"),
    line:
      object.line === null
        ? null
        : Number.isInteger(object.line)
          ? Number(object.line)
          : missing("review comment.line", object.line),
    createdAt: string(object.createdAt, "review comment.createdAt"),
  };
}
function isBugbot(comment: T.ReviewComment | null): boolean {
  if (comment === null) return false;
  const author = (comment.authorLogin ?? "").toLowerCase();
  const body = comment.body.toLowerCase();
  return (
    author.includes("bugbot") ||
    (author === "cursor" &&
      [
        "bugbot",
        "cursor_automation_id",
        "agentic security review",
        "description start",
        "severity",
      ].some((token) => body.includes(token)))
  );
}
function passKey(comment: T.ReviewComment | null): string | null {
  if (comment === null) return null;
  for (const pattern of [
    /RUN_ID:\s*([a-zA-Z0-9_.:-]+)/,
    /CURSOR_AUTOMATION_ID:\s*([a-zA-Z0-9_.:-]+)/,
  ]) {
    const match = pattern.exec(comment.body);
    if (match?.[1]) return match[1];
  }
  return null;
}
export function parseReviewThreadPage(value: unknown): T.ReviewThreadPage {
  const reviewThreads = record(
    at(value, ["data", "repository", "pullRequest", "reviewThreads"]),
    "reviewThreads"
  );
  const nodes = list(reviewThreads.nodes, "reviewThreads.nodes");
  const threads: T.RawReviewThread[] = [];
  for (const node of nodes) {
    const thread = record(node, "review thread");
    if (typeof thread.isResolved !== "boolean")
      missing("review thread.isResolved", thread.isResolved);
    const comments = list(
      at(thread, ["comments", "nodes"]),
      "review thread.comments.nodes"
    );
    threads.push({
      id: string(thread.id, "review thread.id"),
      firstComment: comments.length === 0 ? null : parseComment(comments[0]),
      resolved: thread.isResolved,
    });
  }
  const page = record(reviewThreads.pageInfo, "reviewThreads.pageInfo");
  if (typeof page.hasNextPage !== "boolean")
    missing("reviewThreads.pageInfo.hasNextPage", page.hasNextPage);
  const cursor = optionalString(
    page.endCursor,
    "reviewThreads.pageInfo.endCursor"
  );
  return { threads, endCursor: page.hasNextPage && cursor ? cursor : null };
}
/** Bugbot posts each pass as threads that share a RUN_ID. */
function bugbotThreadPasses(threads: readonly T.RawReviewThread[]): number {
  const keys = new Set<string>();
  let keyless = false;
  for (const thread of threads) {
    if (!isBugbot(thread.firstComment)) continue;
    const key = passKey(thread.firstComment);
    if (key === null) keyless = true;
    else keys.add(key);
  }
  return keys.size > 0 ? keys.size : keyless ? 1 : 0;
}
export function buildReviewThreads(
  threads: readonly T.RawReviewThread[]
): readonly T.ReviewThread[] {
  const passes = bugbotThreadPasses(threads);
  return threads
    .filter((thread) => !thread.resolved)
    .map(({ id, firstComment }) => ({
      id,
      firstComment,
      isBugbot: isBugbot(firstComment),
      bugbotReviewPasses: passes,
    }));
}
const REVIEW_STATES = [
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
] as const;
export function parseReviewPage(value: unknown): T.ReviewPage {
  const connection = record(
    at(value, ["data", "repository", "pullRequest", "reviews"]),
    "reviews"
  );
  const reviews: T.RawReview[] = [];
  for (const node of list(connection.nodes, "reviews.nodes")) {
    const review = record(node, "review");
    const state = enumValue(review.state, REVIEW_STATES, "review.state");
    if (state === "PENDING") continue;
    const author = parseAuthor(review.author, "review.author");
    const commit =
      review.commit === null ? null : record(review.commit, "review.commit");
    reviews.push({
      id: string(review.id, "review.id"),
      authorLogin: author?.login ?? null,
      authorIsBot: author?.isBot ?? false,
      body: string(review.body, "review.body"),
      state,
      commitOid: commit === null ? null : string(commit.oid, "review.commit.oid"),
      submittedAt: string(review.submittedAt, "review.submittedAt"),
    });
  }
  const page = record(connection.pageInfo, "reviews.pageInfo");
  if (typeof page.hasNextPage !== "boolean")
    missing("reviews.pageInfo.hasNextPage", page.hasNextPage);
  const cursor = optionalString(page.endCursor, "reviews.pageInfo.endCursor");
  return { reviews, endCursor: page.hasNextPage && cursor ? cursor : null };
}
/**
 * One review pass is one bot author's non-empty review on one head commit, so
 * a pass that posts a summary and an empty review holding its inline comments
 * counts once. Cursor Bugbot also posts passes as threads keyed by RUN_ID; its
 * entry takes the larger of the two counts, since both count the same passes.
 */
export function countReviewPasses(
  reviews: readonly T.RawReview[],
  threads: readonly T.RawReviewThread[]
): readonly T.BotReviewPasses[] {
  const commits = new Map<string, Set<string>>();
  const latest = new Map<string, T.BotReviewPasses["latestPass"]>();
  for (const review of reviews) {
    const author = review.authorLogin;
    if (!review.authorIsBot || author === null || review.commitOid === null)
      continue;
    if (review.body.trim() === "") continue;
    commits.set(author, (commits.get(author) ?? new Set()).add(review.commitOid));
    const previous = latest.get(author) ?? null;
    if (previous === null || review.submittedAt > previous.submittedAt)
      latest.set(author, {
        reviewId: review.id,
        commitOid: review.commitOid,
        submittedAt: review.submittedAt,
      });
  }
  const bugbotThreads = new Map<string, T.RawReviewThread[]>();
  for (const thread of threads) {
    const author = thread.firstComment?.authorLogin ?? null;
    if (author === null || !isBugbot(thread.firstComment)) continue;
    bugbotThreads.set(author, [...(bugbotThreads.get(author) ?? []), thread]);
  }
  const authors = [...new Set([...commits.keys(), ...bugbotThreads.keys()])];
  return authors.sort().map((author) => ({
    author,
    passes: Math.max(
      commits.get(author)?.size ?? 0,
      bugbotThreadPasses(bugbotThreads.get(author) ?? [])
    ),
    latestPass: latest.get(author) ?? null,
  }));
}
export function parsePullRequest(
  value: unknown,
  context: T.PrContext
): T.PullRequestFacts {
  const object = record(value, "pull request");
  if (typeof object.isDraft !== "boolean")
    missing("pull request.isDraft", object.isDraft);
  return {
    context,
    mergeable: enumValue(
      object.mergeable,
      ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const,
      "pull request.mergeable"
    ),
    mergeStateStatus: enumValue(
      object.mergeStateStatus,
      MERGE_STATES,
      "pull request.mergeStateStatus"
    ),
    reviewDecision: reviewDecision(object.reviewDecision),
    headRefOid: optionalString(object.headRefOid, "pull request.headRefOid"),
    headRefName: string(object.headRefName, "pull request.headRefName"),
    baseRefName: string(object.baseRefName, "pull request.baseRefName"),
    state: enumValue(
      object.state,
      ["OPEN", "CLOSED", "MERGED"] as const,
      "pull request.state"
    ),
    mergedAt: optionalString(object.mergedAt, "pull request.mergedAt"),
    isDraft: object.isDraft,
  };
}
function graphqlArgs(
  query: string,
  context: T.PrContext
): [string, ...string[]] {
  return [
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${context.owner}`,
    "-f",
    `repo=${context.repo}`,
    "-F",
    `pr=${context.number}`,
  ];
}

export class GhGitHubReader implements T.GitHubReader {
  readonly #runJson: typeof runJson;
  /** Takes the runner for gh commands that print JSON, so a test can stand in for gh. */
  constructor(json: typeof runJson = runJson) {
    this.#runJson = json;
  }
  async originRepo(): Promise<T.Repository | null> {
    const result = await run(["git", "remote", "get-url", "origin"]);
    return result.code === 0 ? parseRemote(result.stdout) : null;
  }
  async currentPr(pr: T.PrNumber | null): Promise<T.PrContext> {
    const argv: [string, ...string[]] = ["gh", "pr", "view"];
    if (pr !== null) argv.push(String(pr));
    argv.push("--json", "number,url");
    const object = record(await this.#runJson(argv), "current PR");
    const parsed = parsePrUrl(string(object.url, "current PR.url"));
    return {
      ...parsed,
      number: pr ?? parsePrNumber(object.number, "current PR.number"),
    };
  }
  async pullRequest(context: T.PrContext): Promise<T.PullRequestFacts> {
    return parsePullRequest(
      await this.#runJson([
        "gh",
        "pr",
        "view",
        String(context.number),
        "--repo",
        `${context.owner}/${context.repo}`,
        "--json",
        "mergeable,mergeStateStatus,reviewDecision,headRefOid,headRefName,baseRefName,state,mergedAt,isDraft",
      ]),
      context
    );
  }
  async openPullRequests(
    repository: T.Repository
  ): Promise<readonly T.OpenPullRequest[]> {
    const value = await this.#runJson([
      "gh",
      "pr",
      "list",
      "--repo",
      `${repository.owner}/${repository.repo}`,
      "--state",
      "open",
      "--limit",
      "300",
      "--json",
      "number,headRefName,baseRefName",
    ]);
    return list(value, "open PRs").map((item, index) => {
      const object = record(item, `open PRs[${index}]`);
      return {
        number: parsePrNumber(object.number, `open PRs[${index}].number`),
        headRefName: string(
          object.headRefName,
          `open PRs[${index}].headRefName`
        ),
        baseRefName: string(
          object.baseRefName,
          `open PRs[${index}].baseRefName`
        ),
      };
    });
  }
  async checksFastPath(context: T.PrContext): Promise<T.ChecksFastPath> {
    const result = await run([
      "gh",
      "pr",
      "checks",
      String(context.number),
      "--repo",
      `${context.owner}/${context.repo}`,
      "--json",
      "name,state,description,link,workflow,bucket",
    ]);
    if ([0, 1, 8].includes(result.code) && result.stdout.trim()) {
      try {
        const value = parseJson(result.stdout, "gh pr checks");
        if (Array.isArray(value))
          return { kind: "checks", checks: value.map(parseFastCheck) };
      } catch (error) {
        if (!(error instanceof WatcherQueryError)) throw error;
      }
    }
    return { kind: "unusable", exitCode: result.code, stderr: result.stderr };
  }
  async checkRollupPage(
    context: T.PrContext,
    after: string | null
  ): Promise<T.RollupPage> {
    const argv = graphqlArgs(PR_CHECK_ROLLUP_QUERY, context);
    if (after !== null) argv.push("-f", `after=${after}`);
    const value = await this.#runJson(argv);
    const commits = list(
      at(value, ["data", "repository", "pullRequest", "commits", "nodes"]),
      "commits.nodes"
    );
    if (commits.length === 0) return { kind: "no-rollup" };
    const commit = record(
      at(commits[commits.length - 1], ["commit"]),
      "commit"
    );
    if (commit.statusCheckRollup === null) return { kind: "no-rollup" };
    const contexts = record(
      at(commit, ["statusCheckRollup", "contexts"]),
      "contexts"
    );
    const checks = list(contexts.nodes, "contexts.nodes")
      .map(mapRollupNode)
      .filter((check): check is T.Check => check !== null);
    const page = record(contexts.pageInfo, "contexts.pageInfo");
    if (typeof page.hasNextPage !== "boolean")
      missing("contexts.pageInfo.hasNextPage", page.hasNextPage);
    const cursor = optionalString(
      page.endCursor,
      "contexts.pageInfo.endCursor"
    );
    return {
      kind: "contexts",
      checks,
      endCursor: page.hasNextPage && cursor ? cursor : null,
    };
  }
  async reviewThreadPage(
    context: T.PrContext,
    after: string | null
  ): Promise<T.ReviewThreadPage> {
    const argv = graphqlArgs(REVIEW_THREADS_QUERY, context);
    if (after !== null) argv.push("-f", `after=${after}`);
    return parseReviewThreadPage(await this.#runJson(argv));
  }
  async reviewPage(
    context: T.PrContext,
    after: string | null
  ): Promise<T.ReviewPage> {
    const argv = graphqlArgs(REVIEWS_QUERY, context);
    if (after !== null) argv.push("-f", `after=${after}`);
    return parseReviewPage(await this.#runJson(argv));
  }
  async commitRollups(
    context: T.PrContext
  ): Promise<readonly T.CommitRollup[]> {
    const value = await this.#runJson(graphqlArgs(PR_COMMIT_STATUS_QUERY, context));
    const commits = list(
      at(value, ["data", "repository", "pullRequest", "commits", "nodes"]),
      "commits.nodes"
    );
    return commits.map((item, index) => {
      const commit = record(at(item, ["commit"]), `commits[${index}].commit`);
      const rollup = commit.statusCheckRollup;
      return {
        oid: string(commit.oid, `commits[${index}].oid`),
        state:
          rollup === null
            ? null
            : nullableEnum(
                at(rollup, ["state"]),
                ROLLUP_STATES,
                `commits[${index}].statusCheckRollup.state`
              ),
      };
    });
  }
}

const NO_CHECKS_REPORTED = /^no checks reported/m;
/** The head commit's check contexts, or null when it has no check rollup. */
async function readRollup(
  reader: T.GitHubReader,
  context: T.PrContext
): Promise<readonly T.Check[] | null> {
  const checks: T.Check[] = [];
  let after: string | null = null;
  do {
    const page = await reader.checkRollupPage(context, after);
    if (page.kind === "no-rollup") return after === null ? null : checks;
    checks.push(...page.checks);
    after = page.endCursor;
  } while (after !== null);
  return checks;
}
export async function resolveChecks(
  reader: T.GitHubReader,
  context: T.PrContext
): Promise<T.CheckRead> {
  const fast = await reader.checksFastPath(context);
  const direct = fast.kind === "checks" ? nonEmpty(fast.checks) : null;
  if (direct !== null)
    return { kind: "checks", source: "gh-pr-checks", checks: direct };
  const rollup = await readRollup(reader, context);
  const fallback = rollup === null ? null : nonEmpty(rollup);
  if (fallback !== null)
    return { kind: "checks", source: "graphql-rollup", checks: fallback };
  // Both sources must agree that the commit has no checks. An empty rollup, or
  // any other gh failure, can be a credential that cannot read checks, which
  // must never read as a clean PR.
  if (
    rollup === null &&
    fast.kind === "unusable" &&
    NO_CHECKS_REPORTED.test(fast.stderr)
  )
    return { kind: "no-checks" };
  const suffix =
    fast.kind === "unusable"
      ? `fast path exit=${fast.exitCode}; GraphQL rollup was empty${firstLine(fast.stderr) ? `; ${firstLine(fast.stderr)}` : ""}`
      : "fast path and GraphQL rollup were empty";
  throw new ChecksUnavailable(`could not read PR checks: ${suffix}`);
}
/** Every review thread, resolved ones included, across all pages. */
export async function readReviewThreads(
  reader: T.GitHubReader,
  context: T.PrContext
): Promise<readonly T.RawReviewThread[]> {
  const threads: T.RawReviewThread[] = [];
  let after: string | null = null;
  do {
    const page = await reader.reviewThreadPage(context, after);
    threads.push(...page.threads);
    after = page.endCursor;
  } while (after !== null);
  return threads;
}
export async function resolveReviewThreads(
  reader: T.GitHubReader,
  context: T.PrContext
): Promise<readonly T.ReviewThread[]> {
  return buildReviewThreads(await readReviewThreads(reader, context));
}
export async function resolveReviewPasses(
  reader: T.GitHubReader,
  context: T.PrContext,
  threads: readonly T.RawReviewThread[]
): Promise<readonly T.BotReviewPasses[]> {
  const reviews: T.RawReview[] = [];
  let after: string | null = null;
  do {
    const page = await reader.reviewPage(context, after);
    reviews.push(...page.reviews);
    after = page.endCursor;
  } while (after !== null);
  return countReviewPasses(reviews, threads);
}
export async function resolveContext(args: {
  readonly reader: T.GitHubReader;
  readonly owner: string | null;
  readonly repo: string | null;
  readonly pr: T.PrNumber | null;
}): Promise<T.PrContext> {
  if (args.pr !== null && args.owner !== null && args.repo !== null)
    return { owner: args.owner, repo: args.repo, number: args.pr };
  if (args.pr !== null) {
    const origin = await args.reader.originRepo();
    if (origin !== null)
      return {
        owner: args.owner ?? origin.owner,
        repo: args.repo ?? origin.repo,
        number: args.pr,
      };
  }
  const inferred = await args.reader.currentPr(args.pr);
  return {
    owner: args.owner ?? inferred.owner,
    repo: args.repo ?? inferred.repo,
    number: args.pr ?? inferred.number,
  };
}
export function orderStack(
  context: T.PrContext,
  open: readonly T.OpenPullRequest[]
): T.NonEmpty<T.PrContext> {
  const byNumber = new Map(open.map((pr) => [pr.number, pr]));
  const byHead = new Map(open.map((pr) => [pr.headRefName, pr]));
  const children = new Map<string, T.OpenPullRequest[]>();
  for (const pr of open)
    children.set(pr.baseRefName, [...(children.get(pr.baseRefName) ?? []), pr]);
  for (const values of children.values())
    values.sort((a, b) => a.number - b.number);
  const start = byNumber.get(context.number);
  if (start === undefined) return [context];
  const down: T.OpenPullRequest[] = [];
  let current = start;
  while (byHead.has(current.baseRefName)) {
    const parent = byHead.get(current.baseRefName);
    if (parent === undefined) break;
    down.push(parent);
    current = parent;
  }
  const seen = new Set<T.PrNumber>([
    ...down.map((pr) => pr.number),
    start.number,
  ]);
  const up: T.OpenPullRequest[] = [];
  const visit = (parent: T.OpenPullRequest): void => {
    for (const child of children.get(parent.headRefName) ?? []) {
      if (seen.has(child.number)) continue;
      seen.add(child.number);
      up.push(child);
      visit(child);
    }
  };
  visit(start);
  return (
    nonEmpty(
      [...down.reverse(), start, ...up].map((pr) => ({
        ...context,
        number: pr.number,
      }))
    ) ?? [context]
  );
}
export async function discoverStack(
  reader: T.GitHubReader,
  context: T.PrContext
): Promise<T.NonEmpty<T.PrContext>> {
  return orderStack(context, await reader.openPullRequests(context));
}
