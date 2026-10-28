---
name: eval
description: "Measure how a skill, prompt, system-prompt, or agent-file change affects agent behavior before promoting it: blinded candidates on an organic task, a hidden rubric, one blinded judge, and a check of each candidate's transcript. Use for 'eval this change', or before merging a change whose only test is how agents behave."
disable-model-invocation: true
user-invokable: true
---

# Eval

**You own the experiment design. Plan, blind, run, synthesize.** Keep the run in the state folder under a project-shaped slug, never one of the words the blinding list bans, since a candidate can read its own session path. Keep its decision log there per the **show-me-your-work** skill.

**Non-negotiables for blinding:**

- No `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark`, `candidate`, or `arena` in any directory, file, or prompt the candidate sees.
- The candidate prompt looks like an organic user request. State the goal, not the meta.
- No chain-eliciting cues. Don't ask the candidate to list which skills, principles, or files they applied. Ask for design notes generally and grade chain-following from code shape, not self-report.
- Sanitize directory and slug names. Use project-shaped names a user might pick.
- Don't tell the candidate other candidates exist.
- The judge can know it's judging but sees outputs by sanitized label only, never by model name.
- Comparing two variants: one judge scores both sets in a single pass on one scale, blind to which set each came from.

**Steps:**

1. **Frame.** State what variant is under test and what behavior counts as success. Write the rubric (3-6 concrete criteria) for the judge only. Hold it back from candidates. Name the baseline arm: the change's base commit.
2. **Set up the arms.** Each arm is a worktree of the repository at that arm's commit, with its install run, so the variant is the only difference. For a change to this Pi setup, a candidate runs with `PI_CODING_AGENT_DIR=<arm worktree>/agent`, which loads that arm's `SYSTEM.md`, skills, prompts, and extensions. That directory has no credentials, so first refresh each OAuth token in the live directory for longer than the run will take, `pi auth print-bearer-token --provider <provider> --min-expiry <run length>` for each `oauth` entry in `~/.pi/agent/auth.json`, then `install -m 600` the live `auth.json` into each arm's `agent/`. A token that refreshes inside a copy rotates the live one and logs the live session out. Delete each copy when the run ends.
3. **Set up sanitized environments.** Per-candidate working dir, each its own copy of one seed. Plant any context an organic task would have: a project skeleton, the skills the candidate would naturally read.
4. **Author one organic prompt.** What a user would type. No leakage of what's being measured.
5. **Run the candidates.** Same prompt to each, each in its own sanitized dir, as a plain Pi session through `bg_start`: `PI_CODING_AGENT_DIR=<arm>/agent pi --print --model <model> --thinking high --session-dir <run folder>/sessions/<label> "<prompt>"`. A `pi-subagent` launch appends text that tells the candidate it works for another agent, so use it only when the variant under test is subagent behavior. Run every candidate on one model, the one the variant will run on in practice, so the arms differ only in the variant. Run at least three candidates per arm, interleaving the arms, because one run per arm cannot separate the variant from run-to-run variation.
6. **Spawn one blinded judge** on the other model family per the **arena** skill's Phase C. Judge sees outputs by sanitized label and the rubric, never a model name.
7. **Verify the chain from transcripts, not self-report.** Read each candidate's session file under its `--session-dir`, and only those. List what it actually did with `jq -r 'select(.type=="message" and .message.role=="assistant") | .message.content[]? | select(.type=="toolCall") | "\(.name)\t\(.arguments.path // .arguments.command // .arguments.code | tostring | .[0:200])"' <session>.jsonl`, and read the codemode and bash entries for the files they opened. Grade chain-following from the files it really read plus the shape of the code, never from the candidate's own claims.
8. **Read every candidate output yourself** end to end. Compare to the judge's verdict. Disagreement means a model is biased or the rubric is ambiguous. Synthesize. A variant that does not beat the baseline arm is not promoted, since an unmeasured neutral change still costs every later reader (the **principle-laziness-protocol** skill).
9. **Close the decision log** per the **show-me-your-work** skill.

**Reply:** variant under test, rubric, per-candidate notes, judge's verdict, your synthesis, a recommendation for whether to promote the variant, and the Attention section.
