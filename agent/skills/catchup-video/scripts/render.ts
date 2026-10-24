#!/usr/bin/env node
// Renders a catchup-video deck to a silent mp4: Chromium draws each slide as HTML, ffmpeg encodes
// the stills and crossfades, and the check measures every slide's hold in the decoded file.

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadRenderer, renderChart, THEMES } from "../../statechart/scripts/render.ts";
import { bad, type Deck, failOnProblems, HEIGHT, INK, Invalid, parseDeck, type Placed, WIDTH } from "./deck.ts";

const FPS = 24;
const TRANSITION_FRAMES = 12;
const MIN_HOLD = 2;
const SLACK = 0.5; // seconds a default hold adds past the word rule
const MIN_DIAGRAM_TEXT = 28; // font pixels; smaller diagram text is hard to read in a video
const EXAMPLE = path.join(import.meta.dirname, "example");

const HELP = `Render a catchup video: a silent ${WIDTH}x${HEIGHT} mp4 of slides, then check it.
  node render.ts DECK --out OUT.mp4                render, then check
  node render.ts DECK --out OUT.mp4 --check-only   check an OUT.mp4 rendered from DECK
DECK is a deck.json or a folder holding one. Paths in it are relative to it.

{"colors": {"broken": "red", "fixed": "green", "waits": "amber"},
 "slides": [
  {"put": {
    "page": {"kind": "image", "src": "before.png", "at": [60, 60, 1200, 750]},
    "sum":  {"kind": "highlight", "on": "page", "at": [500, 400, 200, 40], "color": "broken"}}},
  {"put": {"page": {"src": "after.png"}, "sum": {"color": "fixed"}}},
  {"put": {"page": {"at": [60, 60, 600, 375]},
           "you": {"kind": "text", "text": "Waits on you", "at": [1400, 60, 460, 70], "color": "waits"}}},
  {"remove": ["sum"], "hold": 4},
  {"clear": true, "put": {"note": {"kind": "text", "text": "No screenshot yet", "at": [60, 60, 800, 70]}}}]}

Each slide keeps the previous slide's picture. put adds a layer, or changes only the
fields it names on a layer that exists (null drops a field; a new kind replaces it).
remove takes layers out. clear: true starts a new picture. Later layers draw on top.

Every layer has kind and at: [x, y, width, height] in slide pixels. dim: true fades a
layer, and dim: null brings it back.
  text       text, size (32 to 140, default 44). Write \\n for a line break.
  image      src (a PNG), fit: contain (default) or cover, crop: [x, y, w, h] in its
             pixels. at defaults to the whole slide.
  highlight  a ring around at.
  arrow      from (x, y) to (x + width, y + height); width or height may be negative.
  mermaid    source: "flowchart LR\\n  a[Search] -->|no index| b[Every gift]:::broken".
             :::MEANING colors a node.
  bars       values: [{"label": "840 ms", "value": 840, "color": "broken"}], max (default
             the largest value). Give each bar 90 pixels of height.
on: ID puts a text, highlight, or arrow on image ID. Its at is then in that image's own
pixels, and it moves and scales with the image; a text keeps its width, height, and size.
colors gives each meaning one hue: red, amber, green, blue, or violet. A layer's color
names a meaning; without one it is ink.

A deck that reads well, like the one in ${EXAMPLE}:
  - One picture for the whole video: a column of cards, one per item, on every slide.
    Dim the cards a slide is not about and put its point beside the card it is about.
  - A title on every slide that says its point.
  - Crop a screenshot to the part that changed and draw it at least 1000 pixels wide,
    before above after, each labeled. Ring what changed with on.
  - A choice gets one box per option side by side, the pick ringed and labeled.
  - Anything you told the user earlier that turned out wrong goes on the slide of its
    item, with what you said and what is true.
  - The last slide brings every card back, with an arrow to what each waits on you for.
Start from it: cp -r ${EXAMPLE} DIR, then edit DIR/deck.json.

Words in text, bars, and diagrams count; words inside a screenshot do not. A slide holds
max(${MIN_HOLD} s, 1 s per 3 words it adds) + ${SLACK} s. hold: SECONDS may lengthen it,
never shorten it below the rule. Before encoding, every layer must stay on the slide,
text must fit its box, words must not overlap, and diagram text must be at least
${MIN_DIAGRAM_TEXT} px. Each problem prints as "slide N, ID: what to fix".

The check decodes OUT.mp4, matches each frame against each slide's picture, measures each
hold from the file's timestamps, writes OUT.slide-NN.png per slide and OUT.check.txt,
and prints a line per slide: frame, words added, hold, required hold, PASS or FAIL.
Look at every frame before you show the video.

Exit codes: 0 every slide passes, 1 the deck is invalid or a slide fails, 2 could not run.
Needs ffmpeg, ffprobe, and Chromium: $CHROMIUM, /usr/bin/chromium, or chromium,
chromium-browser, or google-chrome on PATH. Mermaid uses the Pele renderer that the
statechart skill installs once into ~/.cache/statechart.
`;

class Unavailable extends Error {}

type Fields = Record<string, unknown>;
type Still = { png: string; words: string[]; added: number; required: number; hold: number };

function object(value: unknown, at: string): Fields {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return { ...value };
  throw new Unavailable(`${at}: expected an object`);
}
function list(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Unavailable(`${at}: expected an array`);
  return value;
}
function string(value: unknown, at: string): string {
  if (typeof value !== "string") throw new Unavailable(`${at}: expected a string`);
  return value;
}

function run(command: string, args: string[], maxBuffer = 128 * 1024 * 1024): Buffer {
  const result = spawnSync(command, args, { maxBuffer });
  if (result.error) throw new Unavailable(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Unavailable(`${command} exited ${result.status}: ${result.stderr.toString().slice(-4000)}`);
  return result.stdout;
}

function chromium(): string {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  if (fs.existsSync("/usr/bin/chromium")) return "/usr/bin/chromium";
  for (const name of ["chromium", "chromium-browser", "google-chrome"])
    for (const dir of (process.env.PATH ?? "").split(path.delimiter))
      if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  throw new Unavailable("no Chromium found; install chromium, or set CHROMIUM to its path");
}

// A tiny DevTools adapter keeps the renderer free of npm dependencies.
class DevTools {
  socket: WebSocket;
  next = 0;
  pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  session = "";
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const msg = object(JSON.parse(String(event.data)), "DevTools message");
      if (typeof msg.id !== "number") return;
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      if (msg.error) call.reject(new Unavailable(`DevTools: ${JSON.stringify(msg.error)}`));
      else call.resolve(msg.result);
    });
    socket.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Unavailable("Chromium connection closed"));
      this.pending.clear();
    });
  }
  async call(method: string, params: object = {}): Promise<unknown> {
    const id = ++this.next;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(this.session ? { sessionId: this.session } : {}) }));
    });
  }
  async evaluate(expression: string): Promise<unknown> {
    const result = object(await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), "evaluate");
    if (result.exceptionDetails) throw new Unavailable(`slide script failed: ${JSON.stringify(result.exceptionDetails)}`);
    return object(result.result, "evaluate result").value;
  }
  async screenshot(file: string) {
    const result = object(await this.call("Page.captureScreenshot", { format: "png" }), "screenshot");
    fs.writeFileSync(file, Buffer.from(string(result.data, "screenshot data"), "base64"));
  }
}

async function launch(temp: string) {
  const browser = spawn(
    chromium(),
    [
      "--headless",
      "--remote-debugging-port=0",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-breakpad",
      "--force-color-profile=srgb",
      `--crash-dumps-dir=${temp}`,
      `--user-data-dir=${path.join(temp, "profile")}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let tools: DevTools | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Unavailable("Chromium did not start within 20 seconds")), 20000);
      browser.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      browser.once("error", (error) => {
        clearTimeout(timer);
        reject(new Unavailable(`Chromium: ${error.message}`));
      });
      browser.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Unavailable(`Chromium exited ${code}: ${stderr.slice(-1500)}`));
      });
    });
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Unavailable("cannot connect to Chromium DevTools")), { once: true });
    });
    tools = new DevTools(socket);
    const target = object(await tools.call("Target.createTarget", { url: "about:blank" }), "target");
    const attached = object(await tools.call("Target.attachToTarget", { targetId: string(target.targetId, "target id"), flatten: true }), "attach");
    tools.session = string(attached.sessionId, "session id");
    await tools.call("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await tools.call("Page.enable");
    const open = tools;
    return {
      tools: open,
      close: async () => {
        open.socket.close();
        browser.kill("SIGTERM");
        if (browser.exitCode === null) await once(browser, "exit");
      },
    };
  } catch (error) {
    tools?.socket.close();
    browser.kill("SIGTERM");
    throw error;
  }
}

const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// Diagrams keep the slides' ink on a quiet blue, and each meaning becomes a class of the same name.
const DIAGRAM = {
  ...THEMES.light,
  stateFill: "#eaf1f7",
  stateBorder: INK,
  stateText: INK,
  edge: INK,
  edgeLabel: INK,
  region: { fill: "#f4f7fa", border: INK, text: INK },
};
async function diagrams(deck: Deck): Promise<Map<string, string>> {
  const svgs = new Map<string, string>();
  const layers = deck.pictures.flatMap((p, i) => p.layers.map((layer) => ({ layer, at: `slide ${i + 1}, ${layer.id}` })));
  if (!layers.some(({ layer }) => layer.kind === "mermaid")) return svgs;
  let lib: Awaited<ReturnType<typeof loadRenderer>>;
  try {
    lib = await loadRenderer();
  } catch (error) {
    throw new Unavailable(error instanceof Error ? error.message : String(error));
  }
  const classes = [...deck.meanings].map(([name, hex]) => `\n  classDef ${name} fill:#ffffff,stroke:${hex},stroke-width:3px,color:${hex}`).join("");
  for (const { layer, at } of layers) {
    if (layer.kind !== "mermaid" || svgs.has(layer.source)) continue;
    const source = /^\s*(flowchart|graph|stateDiagram)/.test(layer.source) ? layer.source + classes : layer.source;
    try {
      svgs.set(layer.source, renderChart(lib, source, { theme: DIAGRAM }).svg);
    } catch (error) {
      bad(`${at}.source`, `does not draw: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
      svgs.set(layer.source, "");
    }
  }
  return svgs;
}

function htmlLayer(p: Placed, svgs: Map<string, string>): string {
  const r = p.rect;
  const id = escapeHtml(p.id);
  const box = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;color:${p.color};${p.dim ? "opacity:0.3;" : ""}`;
  switch (p.kind) {
    case "text":
      return `<div data-layer="${id}" data-fit style="${box}font-size:${p.size}px;line-height:1.2;white-space:pre-line"><span data-words>${escapeHtml(p.text)}</span></div>`;
    case "image": {
      const c = p.crop;
      const data = fs.readFileSync(p.file).toString("base64");
      return `<svg data-layer="${id}" style="${box}" viewBox="${c.x} ${c.y} ${c.w} ${c.h}" preserveAspectRatio="xMidYMid ${p.fit === "cover" ? "slice" : "meet"}"><image href="data:image/png;base64,${data}" width="${p.size[0]}" height="${p.size[1]}"/></svg>`;
    }
    case "highlight":
      return `<div data-layer="${id}" style="${box}border:6px solid currentColor;border-radius:12px;box-sizing:border-box"></div>`;
    case "arrow": {
      // The line runs from (x, y) to (x + w, y + h) inside the box around both ends.
      const left = Math.min(r.x, r.x + r.w);
      const top = Math.min(r.y, r.y + r.h);
      const [x1, y1, x2, y2] = [r.x - left, r.y - top, r.x + r.w - left, r.y + r.h - top];
      const length = Math.hypot(r.w, r.h);
      const [ux, uy] = [r.w / length, r.h / length];
      const head = Math.min(30, length / 2);
      const [bx, by] = [x2 - ux * head, y2 - uy * head];
      const wing = head * 0.55;
      return `<svg data-layer="${id}" style="position:absolute;left:${left}px;top:${top}px;width:${Math.max(1, Math.abs(r.w))}px;height:${Math.max(1, Math.abs(r.h))}px;overflow:visible;color:${p.color};${p.dim ? "opacity:0.3" : ""}"><path d="M${x1} ${y1}L${bx + ux * 2} ${by + uy * 2}" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><polygon points="${x2},${y2} ${bx - uy * wing},${by + ux * wing} ${bx + uy * wing},${by - ux * wing}" fill="currentColor"/></svg>`;
    }
    case "mermaid":
      return `<div data-layer="${id}" data-mermaid style="${box}">${svgs.get(p.source) ?? ""}</div>`;
    case "bars":
      return `<div data-layer="${id}" style="${box}">${p.values
        .map(
          (v) =>
            `<div data-fit style="height:${r.h / p.values.length}px"><div style="font-size:36px;line-height:48px;white-space:nowrap"><span data-words>${escapeHtml(v.label)}</span></div><div style="height:28px;width:${(100 * v.value) / p.max}%;min-width:4px;background:${v.color}"></div></div>`,
        )
        .join("")}</div>`;
    default: {
      const unreachable: never = p;
      return unreachable;
    }
  }
}

// Runs in the page after each slide is drawn: the words it shows, and what does not fit.
const MEASURE = `(async () => {
  await Promise.all([...document.images].map((i) => i.decode()));
  await document.fonts.ready;
  const scene = document.getElementById("scene");
  const owner = (el) => el.closest("[data-layer]").dataset.layer;
  const px = (n) => Math.ceil(n);
  const problems = [];
  for (const el of scene.querySelectorAll("[data-layer]")) {
    const r = el.getBoundingClientRect();
    if (r.left < -0.5 || r.top < -0.5 || r.right > ${WIDTH}.5 || r.bottom > ${HEIGHT}.5)
      problems.push([owner(el), "runs off the slide, at " + [r.left, r.top, r.width, r.height].map(px) + "; keep it inside ${WIDTH}x${HEIGHT}"]);
  }
  for (const el of scene.querySelectorAll("[data-fit]"))
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      problems.push([owner(el), "its words need " + el.scrollWidth + "x" + el.scrollHeight + " px and the box is " + el.clientWidth + "x" + el.clientHeight + "; enlarge at, lower size, or cut words"]);
  const small = new Set();
  for (const t of scene.querySelectorAll("[data-mermaid] text")) {
    // The font size the diagram sets, times the scale its box draws it at.
    const size = parseFloat(getComputedStyle(t).fontSize) * t.getScreenCTM().a;
    if (t.textContent.trim() && size < ${MIN_DIAGRAM_TEXT} && !small.has(owner(t))) {
      small.add(owner(t));
      problems.push([owner(t), "diagram text is " + px(size) + " px, under ${MIN_DIAGRAM_TEXT}; give the diagram a bigger box or fewer nodes"]);
    }
  }
  const words = [...scene.querySelectorAll("[data-words]")];
  for (const [i, a] of words.entries())
    for (const b of words.slice(i + 1)) {
      const [p, q] = [a.getBoundingClientRect(), b.getBoundingClientRect()];
      if (owner(a) !== owner(b) && p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom)
        problems.push([owner(a), "its words overlap " + owner(b) + "'s; move one"]);
    }
  const shown = [...words, ...scene.querySelectorAll("[data-mermaid] text")].map((e) => e.textContent).join(" ");
  return { words: shown, problems };
})()`;

const tokens = (s: string): string[] => s.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+(?:[’'.-][\p{L}\p{N}]+)*/gu) ?? [];
function addedWords(current: string[], previous: string[]): number {
  const counts = new Map<string, number>();
  for (const word of previous) counts.set(word, (counts.get(word) ?? 0) + 1);
  let added = 0;
  for (const word of current) {
    const left = counts.get(word) ?? 0;
    if (left) counts.set(word, left - 1);
    else added++;
  }
  return added;
}

async function renderStills(deck: Deck, temp: string, tools: DevTools): Promise<Still[]> {
  const svgs = await diagrams(deck);
  const page = path.join(temp, "slides.html");
  fs.writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#fff;color:${INK};font-family:system-ui,sans-serif}*{animation:none!important;transition:none!important}#scene{position:relative;width:${WIDTH}px;height:${HEIGHT}px}[data-mermaid]>svg{width:100%!important;height:100%!important;max-width:none!important}</style><div id="scene"></div>`,
  );
  await tools.call("Page.navigate", { url: pathToFileURL(page).href });
  for (let attempt = 0; (await tools.evaluate(`document.readyState === "complete" && !!document.getElementById("scene")`)) !== true; attempt++) {
    if (attempt === 200) throw new Unavailable("the slide page did not load");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const stills: Still[] = [];
  let previous: string[] = [];
  for (const [i, picture] of deck.pictures.entries()) {
    const html = picture.layers.map((l) => htmlLayer(l, svgs)).join("");
    const measured = object(await tools.evaluate(`document.getElementById("scene").innerHTML = ${JSON.stringify(html)}; ${MEASURE}`), "measure");
    for (const problem of list(measured.problems, "problems")) {
      const [id, message] = list(problem, "problem");
      bad(`slide ${i + 1}, ${string(id, "id")}`, string(message, "message"));
    }
    const words = tokens(string(measured.words, "words"));
    const added = addedWords(words, previous);
    const required = Math.max(MIN_HOLD, added / 3);
    const hold = Math.max(picture.hold ?? 0, Math.ceil((required + SLACK) * FPS) / FPS);
    if (picture.hold !== null && picture.hold < required)
      bad(`slide ${i + 1}.hold`, `the slide adds ${added} new word${added === 1 ? "" : "s"}, so it needs ${required.toFixed(2)} s; ${picture.hold} s is too short. Raise hold, cut words, or leave hold out`);
    const png = path.join(temp, `still-${i}.png`);
    await tools.screenshot(png);
    stills.push({ png, words, added, required, hold });
    previous = words;
  }
  failOnProblems();
  return stills;
}

async function encode(stills: Still[], out: string, temp: string, tools: DevTools) {
  const concat: string[] = [];
  const add = (file: string, frames: number) => {
    for (let frame = 0; frame < frames; frame++) concat.push(`file '${file.replaceAll("'", "'\\''")}'\nduration ${(1 / FPS).toFixed(9)}`);
  };
  for (const [i, still] of stills.entries()) {
    const previous = stills[i - 1];
    if (previous) {
      const [a, b] = [previous.png, still.png].map((f) => fs.readFileSync(f).toString("base64"));
      await tools.evaluate(
        `document.getElementById("scene").innerHTML = '<img id="a" style="position:absolute;inset:0" src="data:image/png;base64,${a}"><img id="b" style="position:absolute;inset:0" src="data:image/png;base64,${b}">'; Promise.all([...document.images].map((i) => i.decode()))`,
      );
      for (let f = 1; f <= TRANSITION_FRAMES; f++) {
        // Opacity follows the frame index, never elapsed time, so renders repeat exactly.
        await tools.evaluate(`document.getElementById("b").style.opacity = "${f / (TRANSITION_FRAMES + 1)}"`);
        const file = path.join(temp, `transition-${i}-${f}.png`);
        await tools.screenshot(file);
        add(file, 1);
      }
    }
    add(still.png, Math.round(still.hold * FPS));
  }
  const listFile = path.join(temp, "frames.txt");
  fs.writeFileSync(listFile, `${concat.join("\n")}\n`);
  run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-an", "-r", String(FPS), "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
}

const SMALL_W = 320;
const SMALL_H = 180;
const FRAME_BYTES = SMALL_W * SMALL_H * 3;
function decoded(file: string, reference = false): Buffer {
  // Match the encoder's chroma subsampling before resizing a PNG reference, so both sides
  // go through the same color conversion.
  const filter = `${reference ? "format=yuv420p," : ""}scale=${SMALL_W}:${SMALL_H}:flags=area`;
  return run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-vf", filter, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], 1024 * 1024 * 1024);
}

function distance(a: Buffer, b: Buffer): number {
  // The worst 40x30 tile, so a small changed label does not vanish into a large white slide.
  let worst = 0;
  for (let ty = 0; ty < SMALL_H; ty += 30)
    for (let tx = 0; tx < SMALL_W; tx += 40) {
      let total = 0;
      for (let y = ty; y < ty + 30; y++)
        for (let x = tx; x < tx + 40; x++) {
          const pos = (y * SMALL_W + x) * 3;
          total += Math.abs(a[pos] - b[pos]) + Math.abs(a[pos + 1] - b[pos + 1]) + Math.abs(a[pos + 2] - b[pos + 2]);
        }
      worst = Math.max(worst, total / (40 * 30 * 3));
    }
  return worst;
}

function check(stills: Still[], out: string): boolean {
  if (!fs.existsSync(out)) throw new Invalid(`${out} does not exist; render it first`);
  const probe = object(
    JSON.parse(
      run("ffprobe", ["-v", "error", "-show_streams", "-show_frames", "-show_entries", "stream=codec_type,codec_name,width,height,pix_fmt:frame=best_effort_timestamp_time,duration_time", "-of", "json", out]).toString(),
    ),
    "ffprobe",
  );
  const streams = list(probe.streams, "streams").map((s) => object(s, "stream"));
  const video = streams.find((s) => s.codec_type === "video");
  if (
    !video ||
    streams.some((s) => s.codec_type === "audio") ||
    video.codec_name !== "h264" ||
    video.pix_fmt !== "yuv420p" ||
    typeof video.width !== "number" ||
    typeof video.height !== "number" ||
    video.width < 1280 ||
    video.height < 720 ||
    video.width <= video.height
  )
    throw new Invalid(`${out} must be a silent landscape H.264 yuv420p video of at least 1280x720`);
  const frames = list(probe.frames, "frames").map((f) => {
    const v = object(f, "frame");
    return { time: Number(v.best_effort_timestamp_time), duration: Number(v.duration_time) };
  });
  if (!frames.length || frames.some((f) => !Number.isFinite(f.time) || !Number.isFinite(f.duration) || f.duration <= 0))
    throw new Invalid(`${out} has missing or invalid frame timestamps`);
  const pixels = decoded(out);
  if (pixels.length !== frames.length * FRAME_BYTES) throw new Invalid(`${out}: the decoded frame count does not match ffprobe's timestamps`);
  const references = stills.map((s) => decoded(s.png, true).subarray(0, FRAME_BYTES));
  for (const [i, reference] of references.entries())
    for (let j = 0; j < i; j++)
      if (distance(references[j], reference) < 3.6)
        throw new Invalid(`slides ${j + 1} and ${i + 1} look the same to the check; make the change between them larger or drop one`);
  const minErrors = references.map(() => Infinity);
  const nearest = references.map(() => 0);
  const errors: number[] = [];
  const matches = frames.map((_, i) => {
    const frame = pixels.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES);
    let closest = -1;
    let score = Infinity;
    for (const [n, reference] of references.entries()) {
      const d = distance(frame, reference);
      if (d < minErrors[n]) {
        minErrors[n] = d;
        nearest[n] = i;
      }
      if (d < score) {
        score = d;
        closest = n;
      }
    }
    errors.push(score);
    return score < 1.8 ? closest : -1;
  });
  const stem = out.replace(/\.mp4$/i, "");
  fs.writeFileSync(`${stem}.check.json`, `${JSON.stringify({ frames: frames.map((f, i) => ({ ...f, slide: matches[i] + 1, error: errors[i] })) })}\n`);
  const span = (start: number, end: number) => frames[end].time + frames[end].duration - frames[start].time;
  const lines: string[] = [];
  let passed = true;
  let previousEnd = -1;
  for (const [i, still] of stills.entries()) {
    // The longest run of frames after the previous slide's run that match this slide.
    let [bestStart, bestEnd, start] = [-1, -1, -1];
    for (let f = 0; f <= matches.length; f++) {
      if (matches[f] === i && f > previousEnd) {
        if (start < 0) start = f;
      } else if (start >= 0) {
        if (bestStart < 0 || span(start, f - 1) > span(bestStart, bestEnd)) [bestStart, bestEnd] = [start, f - 1];
        start = -1;
      }
    }
    const hold = bestStart < 0 ? 0 : span(bestStart, bestEnd);
    const ok = hold + 0.00001 >= still.required;
    const frame = `${stem}.slide-${String(i + 1).padStart(2, "0")}.png`;
    const midpoint = bestStart < 0 ? nearest[i] : Math.floor((bestStart + bestEnd) / 2);
    run("ffmpeg", ["-v", "error", "-y", "-i", out, "-vf", `select=eq(n\\,${midpoint})`, "-frames:v", "1", frame]);
    if (bestStart >= 0) previousEnd = bestEnd;
    const missing = bestStart < 0 ? ` | no frame matches this slide, nearest error ${minErrors[i].toFixed(3)}` : "";
    lines.push(`${frame} | words added ${still.added} | hold ${hold.toFixed(3)} s | required ${still.required.toFixed(3)} s | ${ok ? "PASS" : "FAIL"}${missing}`);
    passed &&= ok;
  }
  const report = `${lines.join("\n")}\n`;
  fs.writeFileSync(`${stem}.check.txt`, report);
  process.stdout.write(report);
  return passed;
}

async function main(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return args.length === 0 ? 2 : 0;
  }
  const [source, ...rest] = args;
  let out = "";
  let checkOnly = false;
  while (rest.length) {
    const arg = rest.shift();
    if (arg === "--out") out = rest.shift() ?? "";
    else if (arg === "--check-only") checkOnly = true;
    else throw new Invalid(`unknown argument ${arg}; see --help`);
  }
  if (!out.toLowerCase().endsWith(".mp4")) throw new Invalid("--out must name an .mp4 file; see --help");
  const deck = parseDeck(source);
  for (const command of ["ffmpeg", "ffprobe"]) run(command, ["-version"]);
  out = path.resolve(out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temp = fs.mkdtempSync(path.join(path.dirname(out), ".catchup-render-"));
  const start = performance.now();
  let browser: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    browser = await launch(temp);
    const stills = await renderStills(deck, temp, browser.tools);
    if (!checkOnly) await encode(stills, out, temp, browser.tools);
    await browser.close();
    browser = undefined;
    const ok = check(stills, out);
    process.stderr.write(`${checkOnly ? "Check" : "Render and check"}: ${((performance.now() - start) / 1000).toFixed(1)} s\n`);
    return ok ? 0 : 1;
  } finally {
    if (browser) await browser.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(error instanceof Invalid ? `Invalid deck or video:\n${message}\n` : `Could not run: ${message}\n`);
  process.exitCode = error instanceof Invalid ? 1 : 2;
}
