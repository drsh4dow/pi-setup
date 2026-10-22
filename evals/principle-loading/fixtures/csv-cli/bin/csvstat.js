#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseCsv, summarize } from "../src/stats.js";

const [path, column] = process.argv.slice(2);
const rows = parseCsv(readFileSync(path, "utf8"));
const summary = summarize(rows, column);
console.log(`count ${summary.count}\nmin   ${summary.min}\nmax   ${summary.max}\nmean  ${summary.mean.toFixed(3)}`);
