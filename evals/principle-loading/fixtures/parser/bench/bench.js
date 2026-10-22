import { readFileSync } from "node:fs";
import { parse } from "../src/parse.js";

const queries = readFileSync(new URL("./queries.txt", import.meta.url), "utf8").trim().split("\n");
const start = Date.now();
for (let round = 0; round < 200; round++) for (const query of queries) parse(query);
console.log(`${Date.now() - start} ms`);
