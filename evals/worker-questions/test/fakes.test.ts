import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ARMS } from "../arms.ts";
import { scenarioById } from "../scenarios.ts";
import { readAwsState, readGitHubState, refreshAwsSession } from "../tools-state.ts";
import { prepareRun, runPaths, workerEnv } from "../workdir.ts";

const scratch: string[] = [];

after(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

function run(id: "s2-merge" | "s7-expiry" | "s8-control") {
  const outputDir = mkdtempSync(join(tmpdir(), "wq-fakes-"));
  const scenario = scenarioById(id);
  const prepared = prepareRun({ scenario, arm: ARMS.C, outputDir });

  scratch.push(outputDir, prepared.workdir, ...(prepared.origin === null ? [] : [prepared.origin]));

  const paths = runPaths(outputDir);

  const sh = (command: string) => {
    const result = spawnSync("sh", ["-c", command], {
      cwd: prepared.workdir,
      env: workerEnv({ scenario, paths }),
      encoding: "utf8",
    });

    return { exit: result.status, out: `${result.stdout}${result.stderr}` };
  };

  return { sh, paths };
}

test("the staging session expires after its calls and works again once the parent refreshes it", () => {
  const { sh, paths } = run("s7-expiry");

  for (let call = 0; call < 3; call++)
    assert.equal(sh("aws --profile staging s3api list-buckets").exit, 0);

  const expired = sh("aws --profile staging s3api get-bucket-tagging --bucket invoices-exports");

  assert.equal(expired.exit, 255);
  assert.match(expired.out, /ExpiredToken/);
  assert.equal(sh("aws --profile staging sso login").exit, 1, "the worker cannot log in itself");

  refreshAwsSession(paths.awsState);

  const tags = sh("aws --profile staging s3api get-bucket-tagging --bucket invoices-exports");

  assert.equal(tags.exit, 0);
  assert.match(tags.out, /"Value": "1y"/);
  assert.equal(readAwsState(paths.awsState).loginAttempts, 1);
});

test("without the scenario's fakes, gh and aws reach no account", () => {
  const { sh } = run("s8-control");

  assert.match(
    sh("aws --profile staging sts get-caller-identity").out,
    /Unable to locate credentials/,
  );
  assert.match(sh("gh pr list").out, /gh auth login/);
});

test("a squash merge the repository refuses fails like GitHub, and an allowed method merges", () => {
  const { sh, paths } = run("s2-merge");

  assert.equal(
    sh(
      "git checkout -q -b wq/negative-amounts && git commit -q --allow-empty -m work && git push -q origin wq/negative-amounts",
    ).exit,
    0,
  );
  assert.match(
    sh("gh pr create --title 'Negative amounts' --body 'Refunds in brackets'").out,
    /pull\/1/,
  );

  const squash = sh("gh pr merge 1 --squash");

  assert.equal(squash.exit, 1);
  assert.match(squash.out, /Squash merges are not allowed on this repository/);

  assert.equal(sh("gh pr merge 1 --merge").exit, 0);

  const state = readGitHubState(paths.ghState);

  assert.deepEqual(
    state.pullRequests.map((pr) => [pr.headRefName, pr.state, pr.mergeMethod]),
    [["wq/negative-amounts", "MERGED", "merge"]],
  );
  assert.deepEqual(state.refusedMerges, [{ method: "squash", admin: false }]);
});
