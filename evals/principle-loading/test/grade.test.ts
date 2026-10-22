import assert from "node:assert/strict";
import { test } from "node:test";
import { gradeRun, gradeSession, type RunRecord } from "../grade.ts";

const SKILLS = "/home/dev/.pi/agent/skills";

interface ToolArguments {
  readonly path?: string;
  readonly command?: string;
  readonly code?: string;
  readonly edits?: readonly never[];
}

interface ToolResultFields {
  readonly isError?: boolean;
  readonly details?: { readonly calls: readonly { name: string; args: string; status: string }[] };
}

function assistantCalls(calls: readonly { id: string; name: string; arguments: ToolArguments }[]) {
  return {
    type: "message",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: calls.map((call) => ({ type: "toolCall", ...call })),
    },
  };
}

function toolResult(toolCallId: string, toolName: string, extra: ToolResultFields = {}) {
  return {
    type: "message",
    message: { role: "toolResult", toolCallId, toolName, isError: false, content: [], ...extra },
  };
}

function finalAnswer(text: string) {
  return {
    type: "message",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
  };
}

function session(...entries: readonly object[]) {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

test("counts principle reads through read, codemode, and printing bash commands, in order", () => {
  const grade = gradeSession(
    session(
      assistantCalls([
        { id: "a", name: "read", arguments: { path: `${SKILLS}/principle-push-back/SKILL.md` } },
      ]),
      toolResult("a", "read"),
      assistantCalls([{ id: "b", name: "codemode", arguments: { code: "..." } }]),
      toolResult("b", "codemode", {
        details: {
          calls: [
            {
              name: "read",
              args: JSON.stringify({ path: `${SKILLS}/principle-model-the-domain/SKILL.md` }),
              status: "ok",
            },
            {
              name: "bash",
              args: JSON.stringify({ command: `cat ${SKILLS}/principle-fix-root-causes/SKILL.md` }),
              status: "ok",
            },
          ],
        },
      }),
      finalAnswer("done"),
    ),
  );

  assert.deepEqual(grade.loads, [
    { principle: "principle-push-back", step: 0, channel: "read" },
    { principle: "principle-model-the-domain", step: 1, channel: "codemode read" },
    { principle: "principle-fix-root-causes", step: 2, channel: "bash" },
  ]);
  assert.equal(grade.finalText, "done");
  assert.equal(grade.lastStopReason, "stop");
});

test("counts a codemode read whose recorded arguments were truncated", () => {
  const grade = gradeSession(
    session(
      assistantCalls([{ id: "a", name: "codemode", arguments: { code: "..." } }]),
      toolResult("a", "codemode", {
        details: {
          calls: [
            {
              name: "read",
              args: `{"path":"${SKILLS}/principle-push-back/SKILL.md","offset":nu`,
              status: "ok",
            },
          ],
        },
      }),
      finalAnswer("done"),
    ),
  );

  assert.deepEqual(grade.loads, [
    { principle: "principle-push-back", step: 0, channel: "codemode read" },
  ]);
});

test("does not count failed reads, listings, or other skills", () => {
  const grade = gradeSession(
    session(
      assistantCalls([
        { id: "a", name: "read", arguments: { path: `${SKILLS}/principle-push-back/SKILL.md` } },
        {
          id: "b",
          name: "bash",
          arguments: { command: `ls ${SKILLS}/principle-model-the-domain/SKILL.md` },
        },
        { id: "c", name: "read", arguments: { path: `${SKILLS}/subagents/SKILL.md` } },
      ]),
      toolResult("a", "read", { isError: true }),
      toolResult("b", "bash"),
      toolResult("c", "read"),
      finalAnswer("done"),
    ),
  );

  assert.deepEqual(grade.loads, []);
});

test("a target read after the first edit is loaded but not early", () => {
  const jsonl = session(
    assistantCalls([{ id: "a", name: "edit", arguments: { path: "src/a.ts", edits: [] } }]),
    toolResult("a", "edit"),
    assistantCalls([
      { id: "b", name: "read", arguments: { path: `${SKILLS}/principle-prove-it-works/SKILL.md` } },
    ]),
    toolResult("b", "read"),
    finalAnswer("done"),
  );

  const run: RunRecord = {
    target: "principle-prove-it-works",
    model: "m",
    trial: 1,
    workdir: "/tmp/x",
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
    session: "s.jsonl",
  };

  const graded = gradeRun(run, jsonl);

  assert.equal(graded.invalid, undefined);
  assert.equal(graded.targetLoaded, true);
  assert.equal(graded.targetLoadedEarly, false);
  assert.equal(gradeRun({ ...run, target: "principle-push-back" }, jsonl).targetLoaded, false);
});

test("a run that timed out or ended on an error does not count", () => {
  const run: RunRecord = {
    target: "principle-push-back",
    model: "m",
    trial: 1,
    workdir: "/tmp/x",
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
    session: "s.jsonl",
  };

  const errored = session({
    type: "message",
    message: { role: "assistant", stopReason: "error", content: [] },
  });

  assert.equal(
    gradeRun({ ...run, timedOut: true, exitCode: null }, session(finalAnswer("x"))).invalid,
    "timed out",
  );
  assert.equal(gradeRun(run, errored).invalid, "last stop reason error");
  assert.equal(gradeRun(run, undefined).invalid, "no session file");
});

test("a run that left the project unchanged is reported as changing nothing", () => {
  const run: RunRecord = {
    target: "principle-ask-or-proceed",
    model: "m",
    trial: 1,
    workdir: "/tmp/x",
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
    session: "s.jsonl",
  };

  const answer = session(finalAnswer("ASSUMPTIONS I'M MAKING: ..."));

  assert.equal(gradeRun({ ...run, projectChanges: 0 }, answer).changedNothing, true);
  assert.equal(gradeRun({ ...run, projectChanges: 3 }, answer).changedNothing, false);
  assert.equal(gradeRun(run, answer).changedNothing, undefined);
});
