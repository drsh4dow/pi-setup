#!/usr/bin/env node
// Draws Mermaid files as PNGs with the Pele and resvg renderer the statechart skill installs.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadRenderer, renderPng } from "../../statechart/scripts/render.ts";

const HELP = `Usage: node visualize.ts CHART.mmd [MORE.mmd ...]

Draws each Mermaid file as a PNG next to it, CHART.mmd to CHART.png, and prints
the PNG's absolute path. Read that path with the read tool to show the chart in
the chat.

Every Mermaid diagram type draws. For numbers, use a chart:

  xychart-beta
    title "Search time before and after the index"
    x-axis ["Before", "After"]
    y-axis "Milliseconds" 0 --> 900
    bar [840, 35]

  pie title Checkout tests
    "Pass" : 41
    "Skipped" : 1

xychart-beta also takes a line [..] series. Take every number from the facts it
comes from.

The first run installs Pele and resvg with npm into ~/.cache/statechart, which
needs the network once.

Exit codes: 0 every PNG written, 1 a chart did not render, 2 could not run.`;

async function main(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return args.length === 0 ? 2 : 0;
  }

  let lib;
  try {
    lib = await loadRenderer();
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let status = 0;
  for (const input of args) {
    let src: string;
    try {
      src = fs.readFileSync(input, "utf8");
    } catch (e) {
      console.error(`cannot read ${input}: ${(e as Error).message}`);
      return 2;
    }

    const out = path.resolve(input.replace(/\.mmd$/, "") + ".png");
    try {
      fs.writeFileSync(out, renderPng(lib, src));
    } catch (e) {
      console.error(`could not draw ${input}: ${(e as Error).message}`);
      status = 1;
      continue;
    }
    console.log(out);
  }
  return status;
}

process.exitCode = await main(process.argv.slice(2));
