import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { Type, type TSchema } from "typebox";
import {
  checkSchema,
  commentSchema,
  parseJson,
  prSchema,
  reviewSchema,
  type PreviousSnapshot,
  type PrIdentity,
  type PullRequest,
  type SnapshotInput,
} from "./contracts.ts";

export const DEFAULT_TRUSTED_BOTS = Object.freeze(["coderabbitai[bot]"]);

export class CommandError extends Error {
  readonly status: number | null;

  constructor(command: string, result: SpawnSyncReturns<string>) {
    super(
      `${command} failed with exit ${result.status ?? "unknown"}: ${(result.stderr || result.stdout || "no output").trim()}`,
      { cause: result.error },
    );
    this.status = result.status;
  }
}

export function runCommand(file: string, args: string[], cwd: string, accepted = [0]) {
  const result = spawnSync(file, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

  if (!accepted.includes(result.status ?? -1))
    throw new CommandError(`${file} ${args.join(" ")}`, result);

  return result.stdout;
}

function jsonCommand<S extends TSchema>(schema: S, args: string[], cwd: string) {
  const output = runCommand("gh", args, cwd);

  try {
    // parseJson validates Static<S>; the conditional TypeBox generic is unresolved in Oxlint.
    // oxlint-disable-next-line typescript/no-unsafe-return
    return parseJson(schema, output);
  } catch (error) {
    throw new Error("GitHub returned invalid JSON data", { cause: error });
  }
}

function paginatedGh<S extends TSchema>(schema: S, path: string, cwd: string) {
  return jsonCommand(
    Type.Array(Type.Array(schema)),
    ["api", "--paginate", "--slurp", path],
    cwd,
  ).flat();
}

const threadsSchema = Type.Object({
  data: Type.Object({
    repository: Type.Object({
      pullRequest: Type.Object({
        reviewThreads: Type.Object({
          nodes: Type.Array(
            Type.Object({
              id: Type.String(),
              isResolved: Type.Boolean(),
              comments: Type.Object({
                nodes: Type.Array(Type.Object({ databaseId: Type.Integer() })),
              }),
            }),
          ),
          pageInfo: Type.Object({
            hasNextPage: Type.Boolean(),
            endCursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          }),
        }),
      }),
    }),
  }),
});

function fetchThreads(cwd: string, owner: string, repo: string, number: number) {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:100){nodes{databaseId}}} pageInfo{hasNextPage endCursor}}}}}`;
  const states = new Map<string, boolean>();
  const unresolvedReviewCommentIds = new Set<number>();
  let cursor: string | undefined;

  for (;;) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `number=${number}`,
    ];

    if (cursor) args.push("-F", `cursor=${cursor}`);
    const { data } = jsonCommand(threadsSchema, args, cwd);
    const threads = data.repository.pullRequest.reviewThreads;

    for (const thread of threads.nodes) {
      states.set(thread.id, thread.isResolved);

      if (!thread.isResolved) {
        for (const comment of thread.comments.nodes)
          unresolvedReviewCommentIds.add(comment.databaseId);
      }
    }

    if (!threads.pageInfo.hasNextPage) break;

    if (!threads.pageInfo.endCursor || threads.pageInfo.endCursor === cursor)
      throw new Error("GitHub returned an invalid review-thread cursor");
    cursor = threads.pageInfo.endCursor;
  }

  return { states, unresolvedReviewCommentIds };
}

function identityFrom(pr: PullRequest, nameWithOwner: string): PrIdentity {
  const [owner, repo] = nameWithOwner.split("/");
  const url = new URL(pr.url);

  if (!owner || !repo) throw new Error("GitHub returned an invalid PR identity");

  return { host: url.host, owner, repo, pr: pr.number };
}

export function resolvePr(cwd: string, reference: string) {
  const repository = jsonCommand(
    Type.Object({ nameWithOwner: Type.String() }),
    ["repo", "view", "--json", "nameWithOwner"],
    cwd,
  );

  const pr = jsonCommand(
    prSchema,
    [
      "pr",
      "view",
      reference,
      "--json",
      "number,url,state,mergedAt,closedAt,mergeable,mergeStateStatus,headRefOid,baseRefOid,baseRefName,headRefName,author",
    ],
    cwd,
  );

  return { pr, identity: identityFrom(pr, repository.nameWithOwner) };
}

export function trustedLogins(
  cwd: string,
  identity: PrIdentity,
  prAuthor: string,
  actors: Set<string>,
  trustedBots: Set<string>,
) {
  const trusted = new Set<string>();

  for (const login of new Set([...actors, prAuthor])) {
    if (!login || trusted.has(login)) continue;

    if (login.endsWith("[bot]")) {
      if (trustedBots.has(login)) trusted.add(login);
      continue;
    }

    const result = spawnSync(
      "gh",
      [
        "api",
        `repos/${identity.owner}/${identity.repo}/collaborators/${encodeURIComponent(login)}/permission`,
        "--jq",
        ".permission",
      ],
      { cwd, encoding: "utf8" },
    );

    if (result.status !== 0) continue;

    if (["admin", "maintain", "write"].includes(result.stdout.trim())) trusted.add(login);
  }

  return trusted;
}

export function terminalState(pr: PullRequest) {
  if (pr.mergedAt || pr.state === "MERGED") return "merged";

  if (pr.state === "CLOSED" || pr.closedAt) return "closed";

  return null;
}

export interface Snapshot {
  pr: PullRequest;
  identity: PrIdentity;
  input: SnapshotInput | null;
}

export function fetchSnapshot(
  cwd: string,
  reference: string,
  previous: PreviousSnapshot,
  trustedBots = new Set(DEFAULT_TRUSTED_BOTS),
): Snapshot {
  const resolved = resolvePr(cwd, reference);

  if (terminalState(resolved.pr)) return { ...resolved, input: null };
  const { identity } = resolved;

  const target = jsonCommand(
    Type.Object({ object: Type.Object({ sha: Type.String({ minLength: 1 }) }) }),
    [
      "api",
      `repos/${identity.owner}/${identity.repo}/git/ref/heads/${encodeURIComponent(resolved.pr.baseRefName)}`,
    ],
    cwd,
  );

  // A PR's baseRefOid can remain at its recorded base after the target advances.
  const pr = { ...resolved.pr, baseRefOid: target.object.sha };

  const issueComments = paginatedGh(
    commentSchema,
    `repos/${identity.owner}/${identity.repo}/issues/${pr.number}/comments`,
    cwd,
  );

  const reviewComments = paginatedGh(
    commentSchema,
    `repos/${identity.owner}/${identity.repo}/pulls/${pr.number}/comments`,
    cwd,
  );

  const reviews = paginatedGh(
    reviewSchema,
    `repos/${identity.owner}/${identity.repo}/pulls/${pr.number}/reviews`,
    cwd,
  );

  const checksOutput = runCommand(
    "gh",
    ["pr", "checks", String(pr.number), "--json", "name,state,bucket,link,workflow,completedAt"],
    cwd,
    [0, 1, 8],
  );

  const checks = parseJson(Type.Array(checkSchema), checksOutput.trim() || "[]");

  const comparison = jsonCommand(
    Type.Object({ behind_by: Type.Integer({ minimum: 0 }) }),
    ["api", `repos/${identity.owner}/${identity.repo}/compare/${pr.baseRefOid}...${pr.headRefOid}`],
    cwd,
  );

  const threads = fetchThreads(cwd, identity.owner, identity.repo, pr.number);
  const selfLogin = runCommand("gh", ["api", "user", "--jq", ".login"], cwd).trim();

  if (!selfLogin) throw new Error("GitHub did not return the authenticated login");

  if (previous.selfLogin && previous.selfLogin !== selfLogin)
    throw new Error(
      `GitHub identity changed from ${previous.selfLogin} to ${selfLogin}; restart babysit-pr deliberately with the intended account.`,
    );

  const actors = new Set(
    [...issueComments, ...reviewComments, ...reviews].map((item) => item.user.login),
  );

  const prAuthor = pr.author?.login;

  if (!prAuthor) throw new Error("GitHub did not return the PR author");

  return {
    ...resolved,
    pr,
    input: {
      pr,
      issueComments,
      reviewComments,
      reviews,
      checks,
      comparison,
      unresolvedReviewCommentIds: threads.unresolvedReviewCommentIds,
      threadStates: threads.states,
      previousThreadStates: previous.threadStates,
      selfLogin,
      trustedLogins: trustedLogins(cwd, identity, prAuthor, actors, trustedBots),
    },
  };
}
