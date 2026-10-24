#!/usr/bin/env node
// Proves arm isolation for one harness checkout with a real two-level run, for about a cent: a
// root Pi in the run's home launches one child through `pi-subagent`, as the subagents skill
// does, and every session the two leave is checked against the arm's harness. --marker names text
// only the arm carries, such as a line added to its SYSTEM.md, that each session must contain.
//
//   node evals/implement-chunk/probe-isolation.ts --arm <root> --out <dir> [--marker <text>]

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { candidateEnv, runPi, writeAtomically } from "../lib/pi-run.ts";
import { killProcessesWithEnv } from "../harness-lessons/workdir.ts";
import { prepareRunHome, runHomeEnv } from "./home.ts";
import { checkSession, differingAppendices, sessionFiles } from "./isolation.ts";

const MODEL = "anthropic/claude-haiku-5-5";

const PROMPT = `Run this exact command with the bash tool, then reply with its stdout and nothing else:

pi-subagent --model ${MODEL} --thinking low --append-system-prompt "$HOME/.pi/agent/skills/subagents/unattended.md" --append-system-prompt "$HOME/.pi/agent/skills/subagents/delegate.md" --name "subagent: isolation probe" <<'SUBAGENT_PROMPT'
Reply with the single word done.
SUBAGENT_PROMPT`;

async function main() {
  const { values } = parseArgs({
    options: { arm: { type: "string" }, out: { type: "string" }, marker: { type: "string" } },
  });

  if (values.arm === undefined || values.out === undefined) {
    console.error(
      "usage: node evals/implement-chunk/probe-isolation.ts --arm <root> --out <dir> [--marker <text>]",
    );
    process.exit(2);
  }

  const arm = resolve(values.arm);
  const out = resolve(values.out);
  const scratch = mkdtempSync(join(tmpdir(), "ic-probe-"));
  const project = join(scratch, "project");
  const home = prepareRunHome({ armRoot: arm, home: join(scratch, "home") });

  mkdirSync(project);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(project, "README.md"), "probe\n");
  execFileSync("git", ["init", "-q"], { cwd: project });

  const rootSessions = join(scratch, "root-session");
  const env = { ...candidateEnv(), ...runHomeEnv(home) };

  const result = await runPi(
    project,
    ["-p", "--model", MODEL, "--thinking", "low", "--session-dir", rootSessions, PROMPT],
    out,
    6 * 60_000,
    env,
  );

  killProcessesWithEnv("HOME", home.home);

  const expected = {
    systemPrompt: readFileSync(join(arm, "agent", "SYSTEM.md"), "utf8"),
    runAgentDir: home.agentDir,
    liveAgentDir: join(homedir(), ".pi", "agent"),
    differingAppendices: differingAppendices({
      liveSubagents: join(homedir(), ".pi", "agent", "skills", "subagents"),
      armSubagents: join(arm, "agent", "skills", "subagents"),
    }),
    marker: values.marker ?? null,
  };

  const checked = (role: string, file: string) => {
    const session = checkSession(file, expected);

    return {
      role,
      name: session.name,
      ok: session.ok,
      problems: session.problems,
      file: session.file.replace(scratch, "<scratch>"),
    };
  };

  const root = sessionFiles(rootSessions).map((file) => checked("root", file));
  const children = sessionFiles(home.sessions).map((file) => checked("child", file));

  cpSync(rootSessions, join(out, "root-session"), { recursive: true });
  cpSync(home.sessions, join(out, "child-sessions"), { recursive: true });
  rmSync(scratch, { recursive: true, force: true });

  const sessions = [...root, ...children];
  const ok = root.length === 1 && children.length >= 1 && sessions.every((session) => session.ok);

  writeAtomically(
    join(out, "isolation.json"),
    `${JSON.stringify({ arm, marker: values.marker ?? null, pi: result, ok, sessions }, null, 2)}\n`,
  );

  for (const session of sessions)
    console.log(
      `${session.ok ? "ok  " : "FAIL"} ${session.role} ${session.name ?? "(unnamed)"}: ${session.problems.join("; ") || "arm harness"}`,
    );

  console.log(
    ok
      ? `isolated: ${children.length} child session(s) ran ${arm}'s harness`
      : "NOT isolated, or no child ran; see isolation.json",
  );
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.main) await main();
