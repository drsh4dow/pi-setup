import { readFileSync } from "node:fs";
import * as money from "../src/money.js";

const examples = readFileSync("docs/api.md", "utf8")
  .split("\n")
  .map((line) => /^(.*?)\s*\/\/ => (.*)$/.exec(line))
  .filter((match) => match !== null);

let failed = 0;

for (const [, expression, shown] of examples) {
  const actual = JSON.stringify(new Function(...Object.keys(money), `return ${expression};`)(...Object.values(money)));

  if (actual !== shown) {
    console.error(`docs/api.md: ${expression} gives ${actual}, the example shows ${shown}`);
    failed += 1;
  }
}

process.exitCode = failed === 0 ? 0 : 1;
