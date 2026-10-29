#!/usr/bin/env node
// Chrome DevTools Protocol helpers for recording takes in an agent-owned Chromium. No dependencies (Node >= 22).
//
//   cdp.mjs version    [--port 9222 | --endpoint http://127.0.0.1:9222 | --ws ws://host:port/devtools/browser/ID]
//   cdp.mjs new-window --width 1440 --height 900 [--url about:blank]   # prints {"targetId": ...}
//   cdp.mjs close      --target ID                                     # closes only that target
//   cdp.mjs wheel      --match URL-SUBSTRING --x X --y Y --dy DY [--steps 12]
//   cdp.mjs eval       --match URL-SUBSTRING --expr 'JS'                # prints the value as JSON
//   cdp.mjs --self-test                                                # headless Chromium ($CHROMIUM, default chromium)
//
// new-window: a minimised or hidden window paints nothing (a take records nothing, `mouse move` times out), and
// restoring it over CDP does not help; open a fresh window, attach agent-browser to it, and close only its tabs.
// wheel: a real mouseWheel input event at the pointer's position, in steps, so the page scrolls as under a hand
// (agent-browser's `mouse wheel` fires at 0,0). The endpoint comes from /json/version, never from a
// DevToolsActivePort file of somebody else's browser.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function opts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i] ?? true;
  return o;
}

function endpoint(o) {
  if (o.ws) return `http://${new URL(o.ws).host}`;
  if (o.endpoint) return o.endpoint.replace(/\/$/, "");
  return `http://127.0.0.1:${o.port ?? 9222}`;
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error(`cannot reach ${wsUrl}`)); });
  let id = 0;
  const call = (method, params = {}) => new Promise((ok, bad) => {
    const n = ++id;
    const h = (e) => {
      const v = JSON.parse(e.data);
      if (v.id !== n) return;
      ws.removeEventListener("message", h);
      v.error ? bad(new Error(`${method}: ${v.error.message}`)) : ok(v.result);
    };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { call, close: () => ws.close() };
}

async function json(base, path) {
  const r = await fetch(`${base}${path}`);
  if (!r.ok) throw new Error(`${base}${path}: HTTP ${r.status}`);
  return r.json();
}

async function page(base, match) {
  const pages = (await json(base, "/json/list")).filter((t) => t.type === "page" && t.url.includes(match ?? ""));
  if (!pages.length) throw new Error(`no page whose URL contains ${JSON.stringify(match)}`);
  return connect(pages[0].webSocketDebuggerUrl);
}

const commands = {
  async version(o) {
    return json(endpoint(o), "/json/version");
  },
  async "new-window"(o) {
    const b = await connect((await json(endpoint(o), "/json/version")).webSocketDebuggerUrl);
    try {
      return await b.call("Target.createTarget", {
        url: o.url ?? "about:blank", newWindow: true, width: Number(o.width ?? 1440), height: Number(o.height ?? 900),
      });
    } finally { b.close(); }
  },
  async close(o) {
    const b = await connect((await json(endpoint(o), "/json/version")).webSocketDebuggerUrl);
    try { return await b.call("Target.closeTarget", { targetId: o.target }); } finally { b.close(); }
  },
  async wheel(o) {
    const p = await page(endpoint(o), o.match);
    const steps = Number(o.steps ?? 12), per = Number(o.dy) / steps;
    try {
      for (let i = 0; i < steps; i++) {
        await p.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: Number(o.x), y: Number(o.y), deltaX: 0, deltaY: per });
        await new Promise((r) => setTimeout(r, 16));
      }
      return { steps, dy: Number(o.dy) };
    } finally { p.close(); }
  },
  async eval(o) {
    const p = await page(endpoint(o), o.match);
    try {
      const r = await p.call("Runtime.evaluate", { expression: o.expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    } finally { p.close(); }
  },
};

async function selfTest() {
  const fails = [];
  const dir = mkdtempSync(join(tmpdir(), "uiw-cdp-"));
  const bin = process.env.CHROMIUM ?? "chromium";
  const chrome = spawn(bin, ["--headless=new", `--user-data-dir=${dir}`, "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  try {
    const portFile = join(dir, "DevToolsActivePort");
    const deadline = Date.now() + 20000;
    while (!existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n")) {
      if (Date.now() > deadline) throw new Error(`${bin} wrote no DevToolsActivePort within 20 s`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const o = { port: readFileSync(portFile, "utf8").split("\n")[0] };
    const html = `<body style="margin:0"><p id=e style="font:20px sans-serif;margin:40px">Contact someone.synthetic@example.com now</p>` +
      `<div style="height:4000px"></div></body>`;
    const { targetId } = await commands["new-window"]({ ...o, width: 800, height: 600, url: `data:text/html,${encodeURIComponent(html)}` });
    const m = { ...o, match: "data:text/html" };
    for (let i = 0; i < 100 && (await commands.eval({ ...m, expr: "document.readyState" })) !== "complete"; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await commands.eval({ ...m, expr: readFileSync(join(here, "mask.js"), "utf8") });
    const covered = await commands.eval({ ...m, expr: `(() => { const r = document.createRange(); const t = document.getElementById('e').firstChild;
      const i = t.data.indexOf('someone'); r.setStart(t, i); r.setEnd(t, t.data.indexOf(' now'));
      const b = r.getBoundingClientRect();
      return [...document.querySelectorAll('.uiw-private-mask')].some(d => { const m = d.getBoundingClientRect();
        return m.left <= b.left + 1 && m.right >= b.right - 1 && m.top <= b.top + 1 && m.bottom >= b.bottom - 1; }); })()` });
    if (covered !== true) fails.push("mask.js left the email uncovered");
    await commands.wheel({ ...m, x: 200, y: 300, dy: 600, steps: 10 });
    let y = 0;
    for (let i = 0; i < 40 && y < 500; i++) {
      y = await commands.eval({ ...m, expr: "scrollY" });
      if (y < 500) await new Promise((r) => setTimeout(r, 50));
    }
    if (y < 500) fails.push(`wheel dy 600 scrolled the page to ${y}`);
    await commands.close({ ...o, target: targetId });
    const left = (await json(endpoint(o), "/json/list")).filter((t) => t.id === targetId);
    if (left.length) fails.push("close left the window's target open");
  } catch (e) {
    fails.push(String(e.message ?? e));
  } finally {
    chrome.kill("SIGTERM");
    await new Promise((r) => (chrome.exitCode === null ? chrome.once("exit", r) : r()));
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`cdp.mjs self-test: ${fails.length ? `FAIL\n  ${fails.join("\n  ")}` : "PASS"}`);
  return fails.length ? 1 : 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "-h" || cmd === "--help") {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 17).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
} else if (cmd === "--self-test") {
  process.exitCode = await selfTest();
} else if (commands[cmd]) {
  try {
    console.log(JSON.stringify(await commands[cmd](opts(rest))));
  } catch (e) {
    console.error(`cdp.mjs ${cmd}: ${e.message}`);
    process.exitCode = 1;
  }
} else {
  console.error(`cdp.mjs: unknown command ${cmd}`);
  process.exitCode = 2;
}
