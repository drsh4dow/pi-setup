// Runs the grader's CLI on the alpha chunk under fixtures/ with a stub `gh` that fails or answers
// oddly for one pull request, on a PATH that cannot reach the real one.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fixtureRoot, type GhAnswer, grade, notFound, placeFixtures, stubGh } from "./harness.ts";

/** Grades the alpha fixture with a stub gh that gives `answers` for some PRs. */
function gradeWithGh(answers: Readonly<Record<string, GhAnswer>>) {
  const root = fixtureRoot();
  const stubDir = mkdtempSync(join(tmpdir(), "coordinator-runs-gh-"));

  try {
    placeFixtures(root);
    stubGh(stubDir, answers);

    return grade(root, stubDir, join(root, "out"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
}

describe("reading pull requests through gh", () => {
  test("a pull request gh cannot find is a warning, and the run goes on", () => {
    const run = gradeWithGh({ "11": notFound("11") });

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /gh found no pull request acme\/app#11/);
  });

  test("any other gh failure ends the run with exit 2, naming the pull request and the cause", () => {
    const run = gradeWithGh({
      "11": {
        stdout: "",
        stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)",
        status: 1,
      },
    });

    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /acme\/app#11/);
    assert.match(run.stderr, /HTTP 401: Bad credentials/);
  });

  test("an answer gh printed that is no pull request ends the run with exit 2", () => {
    const run = gradeWithGh({
      "11": { stdout: "<html>rate limited</html>", stderr: "", status: 0 },
    });

    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /acme\/app#11/);
  });
});
