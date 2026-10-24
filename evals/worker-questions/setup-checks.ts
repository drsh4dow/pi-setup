// The setup state each run depends on, checked before Pi launches: a green base, the plant
// committed, the arm's prompts present, and the fake tools answering as the scenario needs. The
// dry run adds an ask-parent round trip for the L arm.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { type Arm, delegateFile, protocolFile, PUSH_EXTENSION } from "./arms.ts";
import { serveQuestions } from "./protocol.ts";
import type { Scenario } from "./scenario.ts";
import { initialAwsState, readGitHubState, writeState } from "./tools-state.ts";
import { plantFiles, workerEnv, type Prepared, type RunPaths } from "./workdir.ts";

export interface SetupCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CheckContext {
  readonly scenario: Scenario;
  readonly arm: Arm;
  readonly prepared: Prepared;
  readonly paths: RunPaths;
  readonly harness: string;
}

const check = (name: string, ok: boolean, detail = ""): SetupCheck => ({ name, ok, detail });

function sh(context: CheckContext, command: string) {
  const result = spawnSync("sh", ["-c", command], {
    cwd: context.prepared.workdir,
    env: workerEnv({ scenario: context.scenario, paths: context.paths }),
    encoding: "utf8",
    timeout: 60_000,
  });

  return { exit: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function ghCheck(context: CheckContext): SetupCheck {
  const { github } = context.scenario;

  const result = sh(
    context,
    "gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed",
  );

  if (github === null) {
    return check(
      "gh is the fake with no repository",
      result.exit !== 0 && result.out.includes("gh auth login"),
      result.out,
    );
  }

  const expected = JSON.stringify({
    squashMergeAllowed: github.squash,
    mergeCommitAllowed: github.merge,
    rebaseMergeAllowed: github.rebase,
  });

  const state = readGitHubState(context.paths.ghState);
  const pushed = sh(context, `git ls-remote ${state.origin} refs/heads/main`).out !== "";

  return check(
    "fake gh serves the scenario's merge settings and origin has main",
    result.exit === 0 && result.out === expected && pushed,
    result.out,
  );
}

function awsCheck(context: CheckContext): SetupCheck {
  const calls = context.scenario.awsCallsBeforeExpiry;
  const result = sh(context, "aws --profile staging sts get-caller-identity");

  if (calls === null) {
    return check(
      "aws is the fake with no credentials",
      result.exit !== 0 && result.out.includes("Unable to locate credentials"),
      result.out,
    );
  }

  // The probe spent one call of the session; give the run the whole session back.
  writeState(context.paths.awsState, initialAwsState(calls));

  return check(
    "fake aws answers for the staging profile",
    result.exit === 0 && result.out.includes("111122223333"),
    result.out,
  );
}

export function setupChecks(context: CheckContext): SetupCheck[] {
  const { scenario, arm, harness } = context;
  const tests = sh(context, "node --test test/");
  const gate = sh(context, "sh scripts/check.sh");

  const untracked = plantFiles(scenario).filter(
    (file) => sh(context, `git ls-files --error-unmatch '${file}'`).exit !== 0,
  );

  const askParent = sh(context, "command -v ask-parent");

  const checks = [
    check("the base tests pass", tests.exit === 0, tests.out.slice(-500)),
    check("the gate passes at the base", gate.exit === 0, gate.out.slice(-500)),
    check("the plant is committed", untracked.length === 0, untracked.join(", ")),
    check(
      "the arm's subagent prompt exists",
      existsSync(protocolFile(arm, harness)),
      protocolFile(arm, harness),
    ),
    check("delegate.md exists", existsSync(delegateFile(harness)), delegateFile(harness)),
    check(
      arm.askParent ? "ask-parent is on PATH" : "ask-parent is not on PATH",
      (askParent.exit === 0) === arm.askParent,
      askParent.out,
    ),
    ghCheck(context),
    awsCheck(context),
  ];

  if (arm.push) {
    checks.push(
      check(
        "the scenario has a push and the extension exists",
        scenario.knowledge.learned.some((fact) => fact.push !== null) && existsSync(PUSH_EXTENSION),
        PUSH_EXTENSION,
      ),
    );
  }

  // The probes' own calls are not the worker's.
  rmSync(context.paths.ghLog, { force: true });
  rmSync(context.paths.awsLog, { force: true });

  return checks;
}

/** One ask-parent call answered by a stub parent, as the L arm's worker would make it. */
export async function askParentRoundTrip(context: CheckContext): Promise<SetupCheck> {
  const child = spawn("ask-parent", ["dry-run probe: are you there?"], {
    cwd: context.prepared.workdir,
    env: {
      ...workerEnv({ scenario: context.scenario, paths: context.paths }),
      WQ_ASK_TIMEOUT_MS: "20000",
    },
  });

  let out = "";

  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });

  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));

  await serveQuestions({
    dir: context.paths.asks,
    answer: async () => "stub parent: here",
    until: exited,
  });

  const exitCode = await exited;

  rmSync(context.paths.asks, { recursive: true, force: true });

  return check(
    "ask-parent round trip reaches the parent and prints its answer",
    exitCode === 0 && out.includes("stub parent: here"),
    out.trim(),
  );
}
