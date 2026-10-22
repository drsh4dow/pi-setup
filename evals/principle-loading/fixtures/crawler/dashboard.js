import { readFileSync } from "node:fs";

const results = JSON.parse(readFileSync("results.json", "utf8"));
const failed = results.filter((result) => result.status === null || result.status >= 400);
console.log(`${results.length} pages, ${failed.length} failed`);
