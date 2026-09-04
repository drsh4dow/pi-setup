import { spawnSync } from "node:child_process";

export class CommandError extends Error {
	constructor(command, result) {
		super(
			`${command} failed with exit ${result.status ?? "unknown"}: ${(result.stderr || result.stdout || "no output").trim()}`,
		);
		this.status = result.status;
		this.stderr = result.stderr ?? "";
	}
}

export function runCommand(file, args, cwd, accepted = [0]) {
	const result = spawnSync(file, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (!accepted.includes(result.status ?? -1))
		throw new CommandError(`${file} ${args.join(" ")}`, result);
	return result.stdout;
}

function jsonCommand(file, args, cwd, accepted) {
	const output = runCommand(file, args, cwd, accepted);
	try {
		return JSON.parse(output);
	} catch (error) {
		throw new Error(`${file} returned invalid JSON: ${error}`);
	}
}

function paginatedGh(path, cwd) {
	const pages = jsonCommand("gh", ["api", "--paginate", "--slurp", path], cwd);
	if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
		throw new Error(`Unexpected paginated GitHub response for ${path}`);
	return pages.flat();
}

function fetchThreads(cwd, owner, repo, number) {
	const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:100){nodes{databaseId}}} pageInfo{hasNextPage endCursor}}}}}`;
	const states = new Map();
	const unresolvedReviewCommentIds = new Set();
	let cursor;
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
		const response = jsonCommand("gh", args, cwd);
		const threads = response?.data?.repository?.pullRequest?.reviewThreads;
		if (!threads || !Array.isArray(threads.nodes))
			throw new Error("Unexpected GitHub review-thread response");
		for (const thread of threads.nodes) {
			if (
				typeof thread?.id !== "string" ||
				typeof thread.isResolved !== "boolean"
			)
				continue;
			states.set(thread.id, thread.isResolved);
			if (!thread.isResolved)
				for (const comment of thread.comments?.nodes ?? [])
					if (Number.isInteger(comment?.databaseId))
						unresolvedReviewCommentIds.add(comment.databaseId);
		}
		if (!threads.pageInfo?.hasNextPage) break;
		cursor = threads.pageInfo.endCursor;
		if (typeof cursor !== "string" || !cursor) break;
	}
	return { states, unresolvedReviewCommentIds };
}

function identityFrom(pr, nameWithOwner) {
	const [owner, repo] = String(nameWithOwner).split("/");
	const url = new URL(pr.url);
	if (!owner || !repo || !Number.isInteger(pr.number))
		throw new Error("GitHub returned an invalid PR identity");
	return { host: url.host, owner, repo, pr: pr.number };
}

export function resolvePr(cwd, reference) {
	const repository = jsonCommand(
		"gh",
		["repo", "view", "--json", "nameWithOwner"],
		cwd,
	);
	const pr = jsonCommand(
		"gh",
		[
			"pr",
			"view",
			reference,
			"--json",
			"number,url,state,mergedAt,closedAt,mergeable,mergeStateStatus,headRefOid,baseRefOid,baseRefName,headRefName,author",
		],
		cwd,
	);
	if (
		typeof repository?.nameWithOwner !== "string" ||
		typeof pr?.url !== "string" ||
		typeof pr?.headRefOid !== "string" ||
		typeof pr?.baseRefOid !== "string"
	)
		throw new Error("GitHub returned an incomplete PR response");
	return {
		pr,
		identity: identityFrom(pr, repository.nameWithOwner),
		nameWithOwner: repository.nameWithOwner,
	};
}

export function trustedLogins(
	cwd,
	identity,
	prAuthor,
	selfLogin,
	actors,
	trustedBots,
) {
	const trusted = new Set();
	for (const login of new Set([...actors, prAuthor])) {
		if (!login || login === selfLogin || trusted.has(login)) continue;
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
		if (["admin", "maintain", "write"].includes(result.stdout.trim()))
			trusted.add(login);
	}
	return trusted;
}

function changedSince(path, lastPollAt) {
	if (!lastPollAt) return path;
	const parsed = Date.parse(lastPollAt);
	if (!Number.isFinite(parsed)) return path;
	const overlap = new Date(parsed - 1_000).toISOString();
	return `${path}?since=${encodeURIComponent(overlap)}`;
}

export function fetchSnapshot(
	cwd,
	reference,
	previous,
	trustedBots = new Set(),
) {
	const resolved = resolvePr(cwd, reference);
	const { pr, identity } = resolved;
	const issueComments = paginatedGh(
		changedSince(
			`repos/${identity.owner}/${identity.repo}/issues/${pr.number}/comments`,
			previous.lastPollAt,
		),
		cwd,
	);
	const reviewComments = paginatedGh(
		changedSince(
			`repos/${identity.owner}/${identity.repo}/pulls/${pr.number}/comments`,
			previous.lastPollAt,
		),
		cwd,
	);
	const reviews = paginatedGh(
		`repos/${identity.owner}/${identity.repo}/pulls/${pr.number}/reviews`,
		cwd,
	);
	const checksOutput = runCommand(
		"gh",
		[
			"pr",
			"checks",
			String(pr.number),
			"--json",
			"name,state,bucket,link,workflow,completedAt",
		],
		cwd,
		[0, 1, 8],
	);
	const checks = checksOutput.trim() ? JSON.parse(checksOutput) : [];
	if (!Array.isArray(checks))
		throw new Error("GitHub returned invalid check data");
	const comparison = jsonCommand(
		"gh",
		[
			"api",
			`repos/${identity.owner}/${identity.repo}/compare/${pr.baseRefOid}...${pr.headRefOid}`,
		],
		cwd,
	);
	const threads = fetchThreads(cwd, identity.owner, identity.repo, pr.number);
	const selfLogin = runCommand(
		"gh",
		["api", "user", "--jq", ".login"],
		cwd,
	).trim();
	if (!selfLogin)
		throw new Error("GitHub did not return the authenticated login");
	if (previous.selfLogin && previous.selfLogin !== selfLogin)
		throw new Error(
			`GitHub identity changed from ${previous.selfLogin} to ${selfLogin}; restart babysit-pr deliberately with the intended account.`,
		);
	const actors = new Set(
		[...issueComments, ...reviewComments, ...reviews]
			.map((item) => item?.user?.login)
			.filter((login) => typeof login === "string"),
	);
	const prAuthor = pr.author?.login;
	if (typeof prAuthor !== "string")
		throw new Error("GitHub did not return the PR author");
	return {
		...resolved,
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
			trustedLogins: trustedLogins(
				cwd,
				identity,
				prAuthor,
				selfLogin,
				actors,
				trustedBots,
			),
		},
	};
}
