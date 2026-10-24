import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const config = JSON.parse(readFileSync("build.config.json", "utf8"));

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");

for (const name of readdirSync("src")) {
  if (name.endsWith(".mjs")) cpSync(join("src", name), join("dist", name));
}

for (const asset of config.assets) cpSync(asset, join("dist", basename(asset)));

const commit =
  process.env.DEPLOY_COMMIT ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

writeFileSync(join("dist", "version.json"), JSON.stringify({ commit }));
console.log(`built dist/ at ${commit}`);
