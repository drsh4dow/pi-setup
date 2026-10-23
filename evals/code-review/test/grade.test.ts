import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJson, judgementProblems, judgePrompt } from "../grade.ts";
import { prompt, type Defect } from "../scenarios.ts";

test("the judge reply's JSON is found inside prose or a code fence", () => {
  const json = '{"defects":[],"otherBlocking":0}';

  assert.equal(extractJson(json), json);
  assert.equal(extractJson(`Here you go:\n\`\`\`json\n${json}\n\`\`\``), json);
  assert.throws(() => extractJson("no verdict"), /no JSON object/);
});

test("the judge sees each defect's location and summary but not its proof", () => {
  const text = judgePrompt(
    [
      {
        id: "orders-off-by-one",
        lens: "logical-proof",
        file: "src/discount.ts",
        lines: [10, 12],
        summary: "The 10-item tier starts at 11 items.",
        proof: "node -e ... prints 0",
      },
    ],
    "Act on: the tier boundary in discount.ts is off by one.",
  );

  assert.match(text, /src\/discount\.ts/);
  assert.match(text, /starts at 11 items/);
  assert.doesNotMatch(text, /prints 0/);
});

test("every arm gets the same spec, and only the skill arms name a skill", () => {
  const spec = "- Orders over 10 items get 5% off.";

  for (const arm of ["plain", "code-review"] as const) {
    assert.ok(prompt(arm, spec).includes(spec));
  }

  assert.doesNotMatch(prompt("plain", spec), /\/skill:/);
  assert.match(prompt("code-review", spec), /^\/skill:code-review main/);
});

const defect = (id: string): Defect => ({
  id,
  lens: "logical-proof",
  file: "a.ts",
  lines: [1, 2],
  summary: "s",
  proof: "p",
});

const verdict = (id: string) => ({ id, verdict: "blocking" as const, evidence: "e" });

test("a judgement scores only when it gives each planted defect exactly one verdict", () => {
  const defects = [defect("a"), defect("b")];

  const problems = (ids: string[]) =>
    judgementProblems(defects, { defects: ids.map(verdict), otherBlocking: 0 });

  assert.deepEqual(problems(["a", "b"]), []);
  assert.deepEqual(problems(["a"]), ["no verdict for b"]);
  assert.deepEqual(problems(["a", "b", "b"]), ["2 verdicts for b"]);
  assert.deepEqual(problems(["a", "b", "c"]), ["verdict for unknown c"]);
});
