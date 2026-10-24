import { execFileSync } from "node:child_process";

const base = process.env.BASE_REF ?? "origin/main";

const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
  .split("\n")
  .filter((path) => path !== "");

const touchesSource = changed.some((path) => path.startsWith("src/"));

if (touchesSource && !changed.includes("CHANGELOG.md")) {
  console.error(`changelog: src/ changed since ${base} but CHANGELOG.md did not. Add a line under ## Unreleased.`);
  process.exit(1);
}

console.log("changelog: ok");
