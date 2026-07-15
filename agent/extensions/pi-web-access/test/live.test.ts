import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { fetchExaContents, searchExa } from "../exa.ts";
import { clearCloneCache, extractGitHub } from "../github.ts";
import { fetchViaApi } from "../github-api.ts";

const live = process.env.PI_WEB_ACCESS_LIVE === "1";

test("live Exa answer and contents", { skip: !live }, async () => {
  assert.ok(process.env.EXA_API_KEY, "EXA_API_KEY must be set");
  const answer = await Effect.runPromise(
    searchExa("What is the purpose of example.com?"),
  );
  assert.ok(answer.answer.length > 0);
  assert.ok(answer.sources.length > 0);

  const search = await Effect.runPromise(
    searchExa("IANA reserved domains", { numResults: 2 }),
  );
  assert.ok(search.answer.length > 0);
  assert.ok(search.sources.length > 0);

  const [content] = await Effect.runPromise(
    fetchExaContents(["https://example.com"]),
  );
  assert.equal(content.error, null);
  assert.match(content.content, /Example Domain/i);
});

test("live public GitHub API view and clone", { skip: !live }, async () => {
  try {
    const apiView = await Effect.runPromise(
      fetchViaApi(
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
      ),
    );
    assert.equal(apiView?.error, null);
    assert.match(apiView?.content ?? "", /README/i);

    const result = await Effect.runPromise(
      extractGitHub("https://github.com/octocat/Hello-World", true),
    );
    assert.equal(result?.error, null);
    assert.match(result?.content ?? "", /Repository cloned to:/);
    assert.match(result?.content ?? "", /README/i);
  } finally {
    await Effect.runPromise(clearCloneCache());
  }
});
