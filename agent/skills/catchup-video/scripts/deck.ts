// Reads a deck.json into one picture per slide, with every layer placed in slide pixels.
// Deck mistakes are collected rather than thrown one at a time, so a run lists all of them.

import fs from "node:fs";
import path from "node:path";

export const WIDTH = 1920;
export const HEIGHT = 1080;
export const INK = "#15324a";
// A deck gives each hue at most one meaning.
const HUES = {
  red: "#ad3440",
  amber: "#8a5a00",
  green: "#147c55",
  blue: "#1f63b6",
  violet: "#6d43c4",
};
const isHue = (v: unknown): v is keyof typeof HUES => typeof v === "string" && Object.hasOwn(HUES, v);

export type Rect = { x: number; y: number; w: number; h: number };
export type Bar = { label: string; value: number; color: string };
// color is a hex value; the deck names meanings and parsing looks them up.
export type Layer = { color: string } & (
  | { kind: "text"; text: string; size: number }
  | { kind: "image"; file: string; size: [number, number]; fit: "contain" | "cover"; crop: Rect }
  | { kind: "highlight" }
  | { kind: "arrow" }
  | { kind: "mermaid"; source: string }
  | { kind: "bars"; values: Bar[]; max: number }
);
export type Placed = Layer & { id: string; rect: Rect };
export type Picture = { layers: Placed[]; hold: number | null };
export type Deck = { meanings: Map<string, string>; pictures: Picture[] };

// What a layer says before placement: its rect in slide pixels, or in the pixels of image `on`.
type Spec = { layer: Layer; at: Rect; on: string | null };
type Fields = Record<string, unknown>;

export class Invalid extends Error {}

const problems: string[] = [];
export const bad = (at: string, message: string) => {
  problems.push(`${at}: ${message}`);
};
// A layer carried onto later slides repeats its problem there; keep the first slide's.
export function failOnProblems() {
  const seen = new Set<string>();
  const first = problems.filter((p) => {
    const key = p.replace(/^slide \d+, /, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (first.length) throw new Invalid(first.join("\n"));
}

const isFields = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const show = (v: unknown) => JSON.stringify(v) ?? String(v);
const not = (v: unknown) => (v === undefined ? "" : `, not ${show(v)}`);
const COMMON = ["kind", "at", "color", "on"];
const FIELDS = {
  text: ["text", "size"],
  image: ["src", "fit", "crop"],
  highlight: [],
  arrow: [],
  mermaid: ["source"],
  bars: ["values", "max"],
};
const isKind = (v: unknown): v is keyof typeof FIELDS => typeof v === "string" && Object.hasOwn(FIELDS, v);

function text(v: unknown, at: string): string {
  if (typeof v === "string" && v.trim()) return v;
  bad(at, `needs text${not(v)}`);
  return "";
}

function number(v: unknown, at: string, min: number, max: number): number {
  if (isNumber(v) && v >= min && v <= max) return v;
  bad(at, `needs a number from ${min} to ${max}${not(v)}`);
  return min;
}

function rect(v: unknown, at: string, signed: boolean): Rect {
  if (Array.isArray(v) && v.length === 4 && v.every(isNumber)) {
    const [x, y, w, h] = v;
    if (signed ? w !== 0 || h !== 0 : w > 0 && h > 0) return { x, y, w, h };
  }
  bad(at, `needs [x, y, width, height]${signed ? "" : " with width and height above 0"}${not(v)}`);
  return { x: 0, y: 0, w: 1, h: 1 };
}

function pngSize(file: string): [number, number] | null {
  try {
    const head = fs.readFileSync(file).subarray(0, 24);
    if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return null;
    return [head.readUInt32BE(16), head.readUInt32BE(20)];
  } catch {
    return null;
  }
}

function parseLayer(o: Fields, at: string, dir: string, meanings: Map<string, string>): Spec | null {
  const before = problems.length;
  if (!isKind(o.kind)) {
    bad(`${at}.kind`, `is ${show(o.kind)}; use text, image, highlight, arrow, mermaid, or bars`);
    return null;
  }
  const kind = o.kind;
  for (const key of Object.keys(o))
    if (!COMMON.includes(key) && !FIELDS[kind].some((k: string) => k === key))
      bad(`${at}.${key}`, `a ${kind} takes ${[...COMMON, ...FIELDS[kind]].join(", ")}`);
  const color = (v: unknown, where: string): string => {
    if (v === undefined) return INK;
    const hex = typeof v === "string" ? meanings.get(v) : undefined;
    if (hex) return hex;
    bad(where, `${show(v)} is not a meaning in colors; use one of ${[...meanings.keys()].join(", ") || "none yet, so add it to colors"}`);
    return INK;
  };
  let on: string | null = null;
  if (o.on !== undefined) {
    if (kind !== "text" && kind !== "highlight" && kind !== "arrow") bad(`${at}.on`, "only a text, highlight, or arrow goes on an image");
    else on = text(o.on, `${at}.on`);
  }
  const base = { color: color(o.color, `${at}.color`) };
  let layer: Layer;
  let at4: Rect | null = null;
  switch (kind) {
    case "text":
      layer = { ...base, kind, text: text(o.text, `${at}.text`), size: number(o.size ?? 44, `${at}.size`, 32, 140) };
      break;
    case "image": {
      const file = path.resolve(dir, text(o.src, `${at}.src`));
      const size = pngSize(file) ?? [1, 1];
      if (size[0] === 1 && size[1] === 1) bad(`${at}.src`, `${file} is not a readable PNG`);
      const fit = o.fit ?? "contain";
      if (fit !== "contain" && fit !== "cover") bad(`${at}.fit`, "is contain or cover");
      const crop = o.crop === undefined ? { x: 0, y: 0, w: size[0], h: size[1] } : rect(o.crop, `${at}.crop`, false);
      if (crop.x < 0 || crop.y < 0 || crop.x + crop.w > size[0] || crop.y + crop.h > size[1])
        bad(`${at}.crop`, `runs past the image, which is ${size[0]}x${size[1]} pixels`);
      layer = { ...base, kind, file, size, fit: fit === "cover" ? "cover" : "contain", crop };
      at4 = o.at === undefined ? { x: 0, y: 0, w: WIDTH, h: HEIGHT } : null;
      break;
    }
    case "highlight":
    case "arrow":
      layer = { ...base, kind };
      break;
    case "mermaid":
      layer = { ...base, kind, source: text(o.source, `${at}.source`) };
      break;
    case "bars": {
      const raw = Array.isArray(o.values) ? o.values : [];
      if (raw.length < 1 || raw.length > 6) bad(`${at}.values`, `needs 1 to 6 bars, like [{"label": "840 ms", "value": 840}]`);
      const values = raw.map((v: unknown, i): Bar => {
        const b = isFields(v) ? v : {};
        return {
          label: text(b.label, `${at}.values[${i}].label`),
          value: number(b.value, `${at}.values[${i}].value`, 0, 1e12),
          color: color(b.color, `${at}.values[${i}].color`),
        };
      });
      const max = o.max === undefined ? Math.max(1e-9, ...values.map((b) => b.value)) : number(o.max, `${at}.max`, 1e-9, 1e12);
      layer = { ...base, kind, values, max };
      break;
    }
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
  const spec = { layer, at: at4 ?? rect(o.at, `${at}.at`, kind === "arrow"), on };
  return problems.length === before ? spec : null;
}

// The scale and offset that draw an image's crop inside its box, as SVG's xMidYMid meet or slice does.
function transform(image: Extract<Layer, { kind: "image" }>, box: Rect) {
  const c = image.crop;
  const s = (image.fit === "cover" ? Math.max : Math.min)(box.w / c.w, box.h / c.h);
  return { s, x: box.x + (box.w - c.w * s) / 2 - c.x * s, y: box.y + (box.h - c.h * s) / 2 - c.y * s };
}

function place(specs: Map<string, Spec>, broken: Set<string>, at: string): Placed[] {
  const placed: Placed[] = [];
  for (const [id, spec] of specs) {
    let r = spec.at;
    if (spec.on !== null) {
      const target = specs.get(spec.on);
      if (target?.layer.kind !== "image") {
        if (!broken.has(spec.on)) bad(`${at}, ${id}.on`, `${show(spec.on)} is not an image on this slide`);
        continue;
      }
      const t = transform(target.layer, target.at);
      const x = t.x + r.x * t.s;
      const y = t.y + r.y * t.s;
      // A text keeps its own size so it stays readable when its image shrinks.
      r = spec.layer.kind === "text" ? { x, y, w: r.w, h: r.h } : { x, y, w: r.w * t.s, h: r.h * t.s };
    }
    placed.push({ ...spec.layer, id, rect: r });
  }
  return placed;
}

export function parseDeck(input: string): Deck {
  const file = fs.statSync(input, { throwIfNoEntry: false })?.isDirectory() ? path.join(input, "deck.json") : input;
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Invalid(`cannot read the deck ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isFields(json) || !Array.isArray(json.slides) || json.slides.length === 0)
    throw new Invalid(`${file}: a deck is {"colors": {...}, "slides": [...]} with at least one slide`);
  for (const key of Object.keys(json)) if (key !== "colors" && key !== "slides") bad(key, `unknown field; a deck has colors and slides`);
  if (json.slides.length > 10) bad("slides", `has ${json.slides.length} slides; use at most 10, and fewer is better`);

  const meanings = new Map<string, string>();
  const owner = new Map<string, string>();
  for (const [meaning, hue] of Object.entries(isFields(json.colors) ? json.colors : {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(meaning)) bad(`colors.${meaning}`, "a meaning is one lowercase word, like fixed or waits");
    else if (!isHue(hue)) bad(`colors.${meaning}`, `${show(hue)} is not a hue; use one of ${Object.keys(HUES).join(", ")}`);
    else if (owner.has(hue)) bad(`colors.${meaning}`, `${hue} already means ${owner.get(hue)}; give each meaning its own hue`);
    else {
      owner.set(hue, meaning);
      meanings.set(meaning, HUES[hue]);
    }
  }
  if (json.colors !== undefined && !isFields(json.colors)) bad("colors", `maps each meaning to a hue, like {"fixed": "green"}`);

  const dir = path.dirname(path.resolve(file));
  let fields = new Map<string, Fields>();
  let specs = new Map<string, Spec>();
  const broken = new Set<string>();
  const pictures = json.slides.map((value: unknown, i): Picture => {
    const at = `slide ${i + 1}`;
    const slide = isFields(value) ? value : {};
    if (!isFields(value)) bad(at, `is an object with put, remove, clear, or hold`);
    for (const key of Object.keys(slide))
      if (!["put", "remove", "clear", "hold"].includes(key)) bad(`${at}.${key}`, "unknown field; a slide has put, remove, clear, and hold");
    if (slide.clear !== undefined && typeof slide.clear !== "boolean") bad(`${at}.clear`, "is true or false");
    if (slide.clear === true) {
      fields = new Map();
      specs = new Map();
      broken.clear();
    } else {
      fields = new Map(fields);
      specs = new Map(specs);
    }
    const remove = slide.remove ?? [];
    for (const id of Array.isArray(remove) ? remove : [remove]) {
      if (typeof id !== "string" || !fields.has(id)) bad(`${at}.remove`, `${show(id)} is not on the previous slide`);
      else {
        fields.delete(id);
        specs.delete(id);
      }
    }
    const put = slide.put ?? {};
    if (!isFields(put)) bad(`${at}.put`, `maps layer ids to layers, like {"note": {"kind": "text", ...}}`);
    for (const [id, change] of Object.entries(isFields(put) ? put : {})) {
      if (!isFields(change)) {
        bad(`${at}, ${id}`, `is an object, like {"kind": "text", "text": "...", "at": [60, 60, 800, 80]}`);
        continue;
      }
      const old = fields.get(id);
      // A layer keeps every field the slide does not restate, unless the slide gives it a new kind.
      const merged: Fields = old && (change.kind === undefined || change.kind === old.kind) ? { ...old, ...change } : { ...change };
      for (const [key, v] of Object.entries(change)) if (v === null) delete merged[key];
      fields.set(id, merged);
      const spec = parseLayer(merged, `${at}, ${id}`, dir, meanings);
      if (spec) {
        specs.set(id, spec);
        broken.delete(id);
      } else {
        specs.delete(id);
        broken.add(id);
      }
    }
    if (fields.size === 0) bad(at, "shows nothing; put at least one layer");
    const hold = slide.hold === undefined ? null : number(slide.hold, `${at}.hold`, 0.1, 120);
    return { layers: place(specs, broken, at), hold };
  });
  failOnProblems();
  return { meanings, pictures };
}
