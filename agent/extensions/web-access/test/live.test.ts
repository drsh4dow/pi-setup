import assert from "node:assert/strict";
import { test } from "node:test";
import { Config, Effect, Option } from "effect";
import { fetchExaContents, searchExa } from "../exa.ts";
import { clearCloneCache, extractGitHub } from "../github.ts";
import { fetchViaApi } from "../github-api.ts";

const live = Effect.runSync(
	Config.option(Config.nonEmptyString("PI_WEB_ACCESS_LIVE")),
).pipe(Option.exists((value) => value === "1"));

const run = Effect.runPromise;

test("live Exa answer and contents", { skip: !live }, () =>
	run(
		Effect.gen(function* () {
			assert.ok(
				Option.isSome(
					yield* Config.option(Config.nonEmptyString("EXA_API_KEY")),
				),
				"EXA_API_KEY must be set",
			);
			const answer = yield* searchExa("What is the purpose of example.com?");
			assert.ok(answer.answer.length > 0);
			assert.ok(answer.sources.length > 0);

			const search = yield* searchExa("IANA reserved domains", {
				numResults: 2,
			});
			assert.ok(search.answer.length > 0);
			assert.ok(search.sources.length > 0);

			const [content] = yield* fetchExaContents(["https://example.com"]);
			assert.equal(content.error, null);
			assert.match(content.content, /Example Domain/i);
		}),
	),
);

test("live public GitHub API view and clone", { skip: !live }, () =>
	run(
		Effect.gen(function* () {
			const apiView = yield* fetchViaApi(
				"https://github.com/octocat/Hello-World",
				"octocat",
				"Hello-World",
				{
					owner: "octocat",
					repo: "Hello-World",
					ref: "master",
					refIsFullSha: false,
					type: "root",
				},
			);
			assert.equal(apiView?.error, null);
			assert.match(apiView?.content ?? "", /README/i);

			const result = yield* extractGitHub(
				"https://github.com/octocat/Hello-World",
				true,
			);
			assert.equal(result?.error, null);
			assert.match(result?.content ?? "", /Repository cloned to:/);
			assert.match(result?.content ?? "", /README/i);
		}).pipe(Effect.ensuring(clearCloneCache)),
	),
);
